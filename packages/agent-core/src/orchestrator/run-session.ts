import { randomUUID } from 'node:crypto';
import type {
  BaseExecutor,
  ExecutorContext,
  Finding,
  FlowTask,
  PreActionRequest,
  SessionCredentials,
  SessionEvent,
  SessionState,
  SiteClassification,
  SiteIntelligenceSignals,
} from '@qa/shared';
import { credentialsComplete, effectiveAuthState, authPromptForState } from '@qa/chat-agent';
import { buildPlan, injectJourneyTasks } from '../planner/index.js';
import { classifySite } from '../intelligence/classify-site.js';
import { saveSessionState, writeReports } from '../reporter/index.js';
import { parsePrd } from '@qa/prd-parser';
import { UiExecutor, probeAuth, performSessionLogin } from '@qa/explorer-ui';
import { ApiExecutor } from '@qa/explorer-api';
import { ChaosExecutor } from '@qa/chaos-engine';

export type EventCallback = (event: SessionEvent) => void;

const executors: BaseExecutor[] = [new UiExecutor(), new ApiExecutor(), new ChaosExecutor()];

function getExecutor(task: FlowTask): BaseExecutor | undefined {
  return executors.find((e) => e.areas.includes(task.area));
}

function draftCredsToCheck(config: SessionState['config']) {
  return {
    depth: config.depth,
    areas: config.areas,
    credentials: config.credentials ?? { type: 'none' as const },
    authProbe: undefined,
    needsLogin: config.credentials?.type === 'login',
  };
}

export class SessionOrchestrator {
  private states = new Map<string, SessionState>();
  private abortControllers = new Map<string, AbortController>();
  private listeners = new Map<string, Set<EventCallback>>();
  private sessionsDirs = new Map<string, string>();

  createSession(config: SessionState['config']): SessionState {
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: SessionState = {
      id,
      config,
      status: 'pending',
      findings: [],
      progress: { completedTasks: 0, totalTasks: 0, percent: 0 },
      authState: 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    this.states.set(id, state);
    this.emit({ type: 'session:created', sessionId: id, timestamp: now, payload: state });
    return state;
  }

  getSession(id: string): SessionState | undefined {
    return this.states.get(id);
  }

  listSessions(): SessionState[] {
    return Array.from(this.states.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  clearAll(): void {
    // Abort any running sessions first
    for (const [id, ctrl] of this.abortControllers) {
      ctrl.abort();
      this.abortControllers.delete(id);
    }
    this.states.clear();
    this.listeners.clear();
    this.sessionsDirs.clear();
  }

  subscribe(sessionId: string, cb: EventCallback): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(cb);
    return () => this.listeners.get(sessionId)?.delete(cb);
  }

  private emit(event: SessionEvent): void {
    const listeners = this.listeners.get(event.sessionId);
    listeners?.forEach((cb) => cb(event));
  }

  updateCredentials(
    sessionId: string,
    credentials: SessionCredentials,
    authState?: SessionState['authState'],
  ): SessionState {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`Session ${sessionId} not found`);
    state.config.credentials = credentials;
    state.updatedAt = new Date().toISOString();
    state.authState = authState ?? 'ready';
    if (state.status === 'awaiting_auth' && authState && authState !== 'ready') {
      state.status = 'awaiting_auth';
    }
    return state;
  }

  async startSession(sessionId: string, sessionsDir: string): Promise<SessionState> {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`Session ${sessionId} not found`);

    this.sessionsDirs.set(sessionId, sessionsDir);

    state.status = 'planning';
    state.updatedAt = new Date().toISOString();
    this.emit({
      type: 'session:started',
      sessionId,
      timestamp: state.updatedAt,
      payload: { status: 'planning' },
    });

    const probe = await probeAuth(state.config.targetUrl);
    state.authProbe = probe;

    const credsOk = credentialsComplete({
      ...draftCredsToCheck(state.config),
      targetUrl: state.config.targetUrl,
      authProbe: probe,
    });

    if (probe.requiresAuth && !credsOk) {
      state.status = 'awaiting_auth';
      state.authState = probe.suggestedMethod === 'password-otp' ? 'awaiting_password' : 'awaiting_username';
      state.updatedAt = new Date().toISOString();
      await saveSessionState(sessionsDir, state);
      this.emit({
        type: 'auth:required',
        sessionId,
        timestamp: state.updatedAt,
        payload: {
          message: `Login required on "${probe.title || state.config.targetUrl}". Please provide credentials in chat.`,
          suggestedMethod: probe.suggestedMethod,
          probe,
        },
      });
      return state;
    }

    return this.beginExploration(sessionId, sessionsDir);
  }

  async resumeSession(sessionId: string): Promise<SessionState> {
    const state = this.states.get(sessionId);
    const sessionsDir = this.sessionsDirs.get(sessionId);
    if (!state || !sessionsDir) throw new Error(`Session ${sessionId} not found`);

    const probe = state.authProbe;
    const credsOk = credentialsComplete({
      ...draftCredsToCheck(state.config),
      targetUrl: state.config.targetUrl,
      authProbe: probe,
    });

    if (!credsOk) {
      state.status = 'awaiting_auth';
      state.authState = effectiveAuthState({
        ...draftCredsToCheck(state.config),
        targetUrl: state.config.targetUrl,
        authProbe: probe,
      });
      this.emit({
        type: 'auth:required',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          message:
            authPromptForState({
              ...draftCredsToCheck(state.config),
              targetUrl: state.config.targetUrl,
              authProbe: probe,
              authState: state.authState,
            }) || 'Still need complete credentials (username, password, and/or OTP).',
        },
      });
      return state;
    }

    return this.beginExploration(sessionId, sessionsDir);
  }

  private async beginExploration(sessionId: string, sessionsDir: string): Promise<SessionState> {
    const state = this.states.get(sessionId)!;

    const abort = new AbortController();
    this.abortControllers.set(sessionId, abort);

    let prdFeatures: string[] | undefined;
    if (state.config.prdPath) {
      try {
        const parsed = await parsePrd(state.config.prdPath);
        prdFeatures = parsed.features;
      } catch {
        /* ignore */
      }
    }

    state.plan = buildPlan(sessionId, state.config, prdFeatures);
    state.progress = { completedTasks: 0, totalTasks: state.plan.tasks.length, percent: 0 };
    state.status = 'running';
    state.authState = 'ready';
    await saveSessionState(sessionsDir, state);

    // ── Pre-session login (once, shared across all tasks) ─────────────────────
    // Builds an ExecutorContext just for login so the OTP pre-action gate works.
    if (state.config.credentials && state.config.credentials.type !== 'none') {
      const loginCtx: ExecutorContext = {
        sessionId,
        config: state.config,
        sessionsDir,
        onFinding: () => {},
        onLog: (message) => {
          this.emit({ type: 'log', sessionId, timestamp: new Date().toISOString(), payload: { message } });
        },
        onPreActionNeeded: (req: PreActionRequest): Record<string, string> | null => {
          const extras = state.config.credentials?.extras ?? {};
          const otp = extras['otp'];
          if (req.type === 'otp' && !otp) {
            this.emit({
              type: 'pre_action:required',
              sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                request: req,
                missing: ['otp'],
                prompt:
                  '🔐 **OTP sent to your phone.** Enter the code in the chat to continue login.\n\n' +
                  'Reply with: `otp: 123456`',
              },
            });
            return null;
          }
          return otp ? { otp } : null;
        },
      };
      const loginOk = await performSessionLogin(loginCtx);
      if (!loginOk) {
        loginCtx.onLog('[Auth] Pre-session login failed or waiting for OTP — tasks will attempt re-login individually');
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    this.runTasks(sessionId, sessionsDir, abort.signal).catch((err) => {
      state.status = 'failed';
      state.error = (err as Error).message;
      state.updatedAt = new Date().toISOString();
      this.emit({
        type: 'session:failed',
        sessionId,
        timestamp: state.updatedAt,
        payload: { error: state.error },
      });
    });

    return state;
  }

  pauseSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.status = 'paused';
      this.abortControllers.get(sessionId)?.abort();
      state.updatedAt = new Date().toISOString();
      this.emit({
        type: 'session:paused',
        sessionId,
        timestamp: state.updatedAt,
        payload: {},
      });
    }
  }

  private async runTasks(
    sessionId: string,
    sessionsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.states.get(sessionId)!;
    const tasks = state.plan?.tasks ?? [];

    for (const task of tasks) {
      if (signal.aborted) break;

      state.progress.currentTask = task.title;
      state.progress.currentPhase = state.plan?.phases.find((p) =>
        p.taskIds.includes(task.id),
      )?.name;
      state.updatedAt = new Date().toISOString();

      this.emit({
        type: 'task:started',
        sessionId,
        timestamp: state.updatedAt,
        payload: { task },
      });

      this.emit({
        type: 'session:progress',
        sessionId,
        timestamp: state.updatedAt,
        payload: { ...state.progress, status: state.status },
      });

      const ctx: ExecutorContext = {
        sessionId,
        config: state.config,
        sessionsDir,
        classification: state.classification,
        discoveredApiEndpoints: state.discoveredApiEndpoints,
        onFinding: (partial) => {
          const finding: Finding = {
            ...partial,
            id: randomUUID(),
            sessionId,
            createdAt: new Date().toISOString(),
          };
          state.findings.push(finding);
          this.emit({
            type: 'session:finding',
            sessionId,
            timestamp: finding.createdAt,
            payload: finding,
          });
        },
        onLog: (message) => {
          this.emit({
            type: 'log',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: { message },
          });
        },
        onPreActionNeeded: (req: PreActionRequest): Record<string, string> | null => {
          const extras = state.config.credentials?.extras ?? {};

          // User explicitly said "skip" in live chat — honour it for this action
          if (extras['_user_skip'] === 'true') {
            // Clear the skip flag after consuming it once
            delete extras['_user_skip'];
            return null;
          }

          const missing = (req.requiredExtras ?? []).filter((k) => !extras[k]);

          if (missing.length > 0) {
            // Tell the user what's needed via a live chat message
            const prompt =
              `⚠️ **${req.description}** — I need more info before proceeding:\n\n` +
              missing.map((k) => `- \`${k}\`: _not provided_`).join('\n') +
              `\n\nReply with the missing value(s) in the format \`key: value\` (e.g. \`card: 4111111111111111\`) to allow this action, or ignore to skip it.`;

            this.emit({
              type: 'pre_action:required',
              sessionId,
              timestamp: new Date().toISOString(),
              payload: { request: req, missing, prompt },
            });

            ctx.onFinding({
              severity: 'info',
              area: 'UI-Journey',
              title: `Skipped: ${req.description}`,
              steps: [`${req.type} action reached`, 'Required data not provided'],
              expected: `Data provided for: ${missing.join(', ')}`,
              actual: `Action skipped — provide missing data in live chat to test this flow`,
              evidence: [],
              reproRate: 'N/A',
              automationCandidate: false,
            });

            return null;
          }

          return extras;
        },
        onClassification: (raw) => {
          // recon.ts passes raw signals wrapped in a SiteClassification shell
          const signals = (raw as unknown as { _rawSignals?: SiteIntelligenceSignals })._rawSignals;
          if (!signals) return;

          const classification: SiteClassification = classifySite(signals);
          state.classification = classification;
          state.updatedAt = new Date().toISOString();

          this.emit({
            type: 'site:classified',
            sessionId,
            timestamp: state.updatedAt,
            payload: classification,
          });

          // Dynamically inject journey tasks into the remaining plan
          if (state.plan) {
            injectJourneyTasks(state.plan, classification);
            // Update total task count
            state.progress.totalTasks = state.plan.tasks.length;
          }
        },
      };

      const executor = getExecutor(task);
      if (executor) {
        try {
          await executor.execute(task, ctx);
          // Persist any newly discovered API endpoints back to session state
          // so subsequent tasks (API executor) can use them
          if (ctx.discoveredApiEndpoints && ctx.discoveredApiEndpoints.length > 0) {
            const existing = new Set(state.discoveredApiEndpoints ?? []);
            for (const e of ctx.discoveredApiEndpoints) existing.add(e);
            state.discoveredApiEndpoints = [...existing];
          }
        } catch (err) {
          ctx.onLog(`Task failed: ${(err as Error).message}`);
        }
      }

      state.progress.completedTasks += 1;
      state.progress.percent = Math.round(
        (state.progress.completedTasks / state.progress.totalTasks) * 100,
      );

      this.emit({
        type: 'task:completed',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { taskId: task.id },
      });

      await saveSessionState(sessionsDir, state);
    }

    if (!signal.aborted) {
      state.status = 'completed';
      state.progress.percent = 100;
      state.updatedAt = new Date().toISOString();
      await writeReports(sessionsDir, state);
      this.emit({
        type: 'session:completed',
        sessionId,
        timestamp: state.updatedAt,
        payload: state,
      });
    }
  }
}

export const orchestrator = new SessionOrchestrator();
