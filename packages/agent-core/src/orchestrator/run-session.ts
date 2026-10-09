import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { hasAnyLLMKey, activeLLMProvider } from '@qa/shared';
import { credentialsComplete, effectiveAuthState, authPromptForState } from '@qa/chat-agent';
import { buildPlan, injectJourneyTasks, removeUnlikelyTasks } from '../planner/index.js';
import { classifySite } from '../intelligence/classify-site.js';
import { classifySiteWithAI } from '../intelligence/classify-site-ai.js';
import { ensureSiteKnowledge } from '../intelligence/site-knowledge-base.js';
import { saveSessionState, writeSessionReport } from '../reporter/index.js';
import {
  attachFingerprints,
  diffFindingFingerprints,
  fingerprintFinding,
  loadPreviousSessionFindings,
} from '../reporter/finding-diff.js';
import { UiExecutor, probeAuth, performSessionLogin, runEmptyCredentialLoginCheck } from '@qa/explorer-ui';
import { ApiExecutor } from '@qa/explorer-api';
import { ChaosExecutor } from '@qa/chaos-engine';

export type EventCallback = (event: SessionEvent) => void;

/**
 * Every session event previously only went to whatever's actually listening (the
 * websocket bridge to the frontend) — nothing printed to the terminal running `npm run
 * dev`, so debugging a failed run meant either reading session.json after the fact or
 * relying on the chat UI to have rendered the right thing. This makes the live run visible
 * directly in the dev server's terminal as it happens.
 */
function logSessionEventToConsole(event: SessionEvent): void {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tag = `[${event.timestamp.slice(11, 19)}] [${event.sessionId.slice(0, 8)}] ${event.type}`;

  switch (event.type) {
    case 'log':
      console.log(`${tag} — ${p.message ?? ''}`);
      break;
    case 'session:finding': {
      const f = p as { severity?: string; area?: string; title?: string };
      console.log(`${tag} — [${f.severity ?? '?'}] (${f.area ?? '?'}) ${f.title ?? ''}`);
      break;
    }
    case 'auth:required':
      console.log(`${tag} — ${p.message ?? ''}`);
      break;
    case 'pre_action:required':
      console.log(`${tag} — ${p.prompt ?? JSON.stringify(p.request ?? {})}`);
      break;
    case 'session:failed':
      console.log(`${tag} — ${p.error ?? ''}`);
      break;
    case 'session:started':
    case 'session:paused':
    case 'session:completed':
      console.log(`${tag} — ${JSON.stringify(p)}`);
      break;
    default:
      console.log(`${tag}`);
  }
}

const executors: BaseExecutor[] = [new UiExecutor(), new ApiExecutor(), new ChaosExecutor()];

// Some flow classes need routing to a SPECIFIC executor that doesn't otherwise own their
// task.area — confirmed as real, silent dead code via a full audit: 'regression' had NO
// executor claiming it at all (schema-drift, golden-path, AND visual-regression all
// no-opped on every run), and 'security-headers' was being routed to ApiExecutor (which owns
// the 'security' area for xss-probe etc.) even though its real implementation needs a live
// Playwright page (response headers + cookie jar) and only exists in UiExecutor. Area-based
// routing alone can't express "this one flow class in an otherwise-plain-HTTP area needs a
// browser" or "this area is split across two executors" — this override map handles both
// without touching the .areas arrays, which would risk misrouting every OTHER flow class
// already working correctly through them.
const FLOW_CLASS_EXECUTOR_OVERRIDE: Record<string, 'ui' | 'api' | 'chaos'> = {
  'security-headers': 'ui',
  'schema-drift': 'api',
  'golden-path': 'ui',
  'visual-regression': 'ui',
  // All four are scheduled under the `chaos` area (so the planner's chaos-depth budget covers
  // them), but their real implementation is a UI flow (packages/explorer-ui/flows/interruption.ts)
  // — without this override they silently route to ChaosExecutor, whose own entries for the
  // first two were a no-op stub that just logged "handled by UI executor" and never actually
  // invoked it. Discovered the same way idempotency/security-headers were: a flow class present
  // in FLOW_CLASSES and seemingly wired is not evidence it actually runs.
  'back-during-post': 'ui',
  'refresh-during-request': 'ui',
  'cancel-during-loading': 'ui',
  'navigate-away-during-loading': 'ui',
};

function getExecutor(task: FlowTask): BaseExecutor | undefined {
  const override = FLOW_CLASS_EXECUTOR_OVERRIDE[task.flowClass];
  if (override) return executors.find((e) => e.areas.includes(override));
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
  // beginExploration() can run twice for a password+OTP flow (once to submit the password and
  // trigger the real OTP send, once again after the user supplies the code) — this ensures the
  // empty-credential boundary check (§4) only ever runs on the first of those, never re-probing
  // once a real login is already in progress.
  private emptyLoginCheckedSessions = new Set<string>();

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

  /**
   * Read-only rehydration for viewing a completed session (report, findings) after the
   * in-memory Map has lost it — which happens on every single API server restart, since
   * session state was never persisted to anything but this Map. A finished session's
   * state.json on disk is otherwise fully intact and sufficient to redisplay its report;
   * only actions that require a *live* run (start/pause/websocket) still correctly 404 here,
   * since a rehydrated session has no abort controller or in-progress task to control.
   */
  async getSessionOrRehydrate(id: string, sessionsDir: string): Promise<SessionState | undefined> {
    const live = this.states.get(id);
    if (live) return live;
    try {
      const raw = await readFile(join(sessionsDir, id, 'state.json'), 'utf-8');
      const state = JSON.parse(raw) as SessionState;
      this.states.set(id, state);
      this.sessionsDirs.set(id, sessionsDir);
      return state;
    } catch {
      return undefined;
    }
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
    logSessionEventToConsole(event);
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

    state.plan = await buildPlan(sessionId, state.config);
    state.progress = { completedTasks: 0, totalTasks: state.plan.tasks.length, percent: 0 };
    state.status = 'running';
    state.authState = 'ready';
    await saveSessionState(sessionsDir, state);

    // ── Pre-session login (once, shared across all tasks) ─────────────────────
    // Builds an ExecutorContext just for login so the OTP pre-action gate works.
    if (state.config.credentials && state.config.credentials.type !== 'none') {
      let awaitingOtp = false;
      const loginCtx: ExecutorContext = {
        sessionId,
        config: state.config,
        sessionsDir,
        onFinding: (partial) => {
          const finding: Finding = {
            ...partial,
            fingerprint: partial.fingerprint ?? fingerprintFinding(partial),
            taskId: partial.taskId ?? 'login-boundary-check',
            id: randomUUID(),
            sessionId,
            createdAt: new Date().toISOString(),
          };
          state.findings.push(finding);
          this.emit({ type: 'session:finding', sessionId, timestamp: finding.createdAt, payload: finding });
        },
        onLog: (message) => {
          this.emit({ type: 'log', sessionId, timestamp: new Date().toISOString(), payload: { message } });
        },
        onPreActionNeeded: (req: PreActionRequest): Record<string, string> | null => {
          // The chat layer (live-chat.ts's parseAuthFields) writes a supplied OTP to the
          // top-level `credentials.otp` field — the same field credentialsComplete/
          // performLogin already use — NOT to `credentials.extras`, which is a separate
          // generic bag used by unrelated pre-action requests (payments, recipients, etc.).
          const otp = state.config.credentials?.otp;
          if (req.type === 'otp' && !otp) {
            awaitingOtp = true;
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
      // Zero-risk boundary check (§4): submits the login form with every field left blank in
      // its own throwaway browser context, entirely separate from the real login attempt right
      // below. Guarded to run exactly once per real login — not on OTP-continuation re-entry
      // into this same block, and not on a session resume where a real login already happened.
      if (!existsSync(join(sessionsDir, sessionId, 'auth-state.json')) && !this.emptyLoginCheckedSessions.has(sessionId)) {
        this.emptyLoginCheckedSessions.add(sessionId);
        await runEmptyCredentialLoginCheck(loginCtx).catch((err) => {
          loginCtx.onLog(`[LoginBoundary] Check failed, continuing with real login: ${(err as Error).message.slice(0, 150)}`);
        });
      }
      const loginOk = await performSessionLogin(loginCtx);
      if (!loginOk && awaitingOtp) {
        // Genuinely paused, not failed — a real OTP send was just triggered and we're
        // waiting on the user to supply the code. Unlike the hard-failure case below,
        // there is nothing useful to explore yet, so tasks must NOT start running against
        // an unauthenticated page: previously this fell through to runTasks() unconditionally
        // regardless of loginOk, which is exactly why "tasks running unauthenticated" kept
        // showing even right after a fresh OTP request — the exploration had already started
        // before the pause was ever given a chance to be resolved.
        state.authState = 'awaiting_otp';
        state.status = 'awaiting_auth';
        state.updatedAt = new Date().toISOString();
        await saveSessionState(sessionsDir, state);
        loginCtx.onLog('[Auth] Pre-session login paused — waiting for OTP');
        return state;
      }
      if (!loginOk) {
        // authState was optimistically set to 'ready' above — correct it now that the
        // actual login outcome is known, so the UI reflects reality instead of a stale guess.
        state.authState = 'required';
        loginCtx.onLog('[Auth] Pre-session login failed — tasks will attempt re-login individually');
      } else if (loginCtx.postLoginUrl) {
        state.postLoginUrl = loginCtx.postLoginUrl;
        loginCtx.onLog(
          `[Auth] Login completed successfully — exploration will start from ${state.postLoginUrl}`,
        );
      } else {
        // Recover post-login URL from disk if set during saveSessionState
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const metaPath = join(sessionsDir, sessionId, 'auth-meta.json');
          if (existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { postLoginUrl?: string };
            if (meta.postLoginUrl) state.postLoginUrl = meta.postLoginUrl;
          }
        } catch {
          /* ignore */
        }
        loginCtx.onLog('[Auth] Login completed successfully');
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
    // Failure isolation: several consecutive tasks failing with the same page-load-timeout
    // signature means the TARGET is currently degraded, not that each is an independent app
    // bug. Track consecutive occurrences so they can be clustered into one note instead of
    // reported as N unrelated "Task error" findings, and so later tasks fail faster.
    let consecutiveTimeoutFailures = 0;
    let envDegradedNoted = false;
    const TIMEOUT_SIGNATURE = /Timeout \d+ms exceeded/i;
    const ENV_DEGRADED_THRESHOLD = 3;

    // NOT a `for (const task of tasks)` over a fixed snapshot — injectJourneyTasks() and
    // removeUnlikelyTasks() both mutate the plan mid-run by REASSIGNING state.plan.tasks to
    // a new array (not mutating the existing one in place), which a snapshot taken before
    // they run would never see. That previously meant removeUnlikelyTasks's "skip this
    // task" had no actual effect on execution — only on the displayed totalTasks — so
    // completedTasks could exceed the (wrongly shrunk) totalTasks. Re-reading
    // state.plan.tasks fresh each iteration and tracking progress by task id (not array
    // position) makes both dynamic addition and removal actually take effect.
    const executedTaskIds = new Set<string>();
    while (true) {
      if (signal.aborted) break;
      const task = (state.plan?.tasks ?? []).find((t) => !executedTaskIds.has(t.id));
      if (!task) break;
      executedTaskIds.add(task.id);

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
        postLoginUrl: state.postLoginUrl,
        actionInventory: state.actionInventory,
        discoveredRoutes: state.discoveredRoutes,
        environmentChecks: state.environmentChecks,
        accessMap: state.accessMap,
        envDegraded: consecutiveTimeoutFailures >= ENV_DEGRADED_THRESHOLD,
        onFinding: (partial) => {
          const withFp = {
            ...partial,
            fingerprint: partial.fingerprint ?? fingerprintFinding(partial),
            // Auto-tagged rather than left to each flow to remember — the reporter's
            // near-duplicate merge relies on this to tell "the same defect independently
            // found by two different flows" (should merge) apart from "one flow enumerating
            // several genuinely distinct instances" (e.g. one finding per device/zoom-level/
            // DOM-element from a single task) which must never collapse into each other.
            taskId: partial.taskId ?? task.id,
          };
          const finding: Finding = {
            ...withFp,
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
              steps: [
                req.pageUrl ? `Open ${req.pageUrl}` : `Navigate to the page where this action is reached`,
                `Trigger: ${req.description}`,
                `Missing data: ${missing.join(', ')} — reply in the live chat with e.g. \`${missing[0]}: <value>\` to let this run for real`,
              ],
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
        onClassification: async (raw) => {
          // recon.ts passes raw signals wrapped in a SiteClassification shell
          const signals = (raw as unknown as { _rawSignals?: SiteIntelligenceSignals })._rawSignals;
          if (!signals) return;

          // The deterministic rule set is always computed first — it's free, synchronous,
          // and is exactly what gets used if the AI call below is unavailable, slow, or
          // returns something we can't validate. This is a strict upgrade path, never a
          // replacement: classifySite() must keep working standalone regardless of Gemini.
          const ruleBased: SiteClassification = classifySite(signals);
          const aiClassification = await classifySiteWithAI(signals).catch(() => null);
          const classification = aiClassification ?? ruleBased;

          this.emit({
            type: 'log',
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
              message: aiClassification
                ? `[Classify] Using AI (${activeLLMProvider() ?? 'configured provider'}) classification: ${classification.siteType} (${Math.round(classification.confidence * 100)}%)`
                : `[Classify] Using rule-based classification: ${classification.siteType} (${Math.round(classification.confidence * 100)}%) — ${
                    hasAnyLLMKey()
                      ? 'AI classification unavailable or invalid this run'
                      : 'no LLM API key configured'
                  }`,
            },
          });

          state.classification = classification;
          state.updatedAt = new Date().toISOString();

          this.emit({
            type: 'site:classified',
            sessionId,
            timestamp: state.updatedAt,
            payload: classification,
          });

          // Per-CATEGORY knowledge base: keyed by classification.siteType, not hostname — a
          // genuinely different site that lands in the same category (e.g. a second, unrelated
          // fintech app) reuses the doc the FIRST fintech site ever produced. Generated ONLY
          // the first time a category is seen (an explicit product decision — never
          // regenerated/diffed on later runs, just reused silently), so this costs nothing on
          // every subsequent session, even against a totally different site of the same kind.
          try {
            const hostname = new URL(state.config.targetUrl).hostname;
            const knowledgeBaseDir = join(sessionsDir, '..', 'knowledge-base');
            const knowledge = await ensureSiteKnowledge(knowledgeBaseDir, hostname, signals, classification);
            if (knowledge) {
              state.siteKnowledge = knowledge.content;
              this.emit({
                type: 'log',
                sessionId,
                timestamp: new Date().toISOString(),
                payload: {
                  message: knowledge.isNew
                    ? `[Knowledge] First "${classification.siteType}"-category site seen (${hostname}) — captured a new application walkthrough doc for this category`
                    : `[Knowledge] Reusing existing "${classification.siteType}"-category walkthrough doc (captured from a previously-seen site of this kind)`,
                },
              });
            }
          } catch (err) {
            this.emit({
              type: 'log',
              sessionId,
              timestamp: new Date().toISOString(),
              payload: { message: `[Knowledge] Could not load/generate site knowledge: ${(err as Error).message.slice(0, 150)}` },
            });
          }

          // Dynamically inject journey tasks into the remaining plan, and drop
          // already-queued generic-matrix tasks recon gives clear evidence are moot
          // (e.g. file-upload edge cases with no file input anywhere on the landing page)
          if (state.plan) {
            injectJourneyTasks(state.plan, classification);
            if (signals) removeUnlikelyTasks(state.plan, signals);
            // Update total task count
            state.progress.totalTasks = state.plan.tasks.length;
          }
        },
      };

      const executor = getExecutor(task);
      const findingsCountBeforeTask = state.findings.length;
      // ctx is built FROM state's own fields above (e.g. `actionInventory: state.actionInventory`
      // at construction) — so ctx.actionInventory is already truthy on every task after the one
      // that first set it, REGARDLESS of whether this task's flow touched it at all. Checking
      // `if (ctx.actionInventory)` alone re-runs the merge below on every subsequent task, and
      // since ctx.actionInventory === state.actionInventory when nothing changed, the entries
      // concat becomes `[...X, ...X]` — doubling the array every single task (confirmed: reached
      // 2,097,152 = 2^21 entries from one real candidate, a ~450MB session state that could no
      // longer be JSON-serialized). Snapshotting these references before execute() and only
      // merging when they actually changed fixes this at the root.
      const before = {
        discoveredApiEndpoints: ctx.discoveredApiEndpoints,
        postLoginUrl: ctx.postLoginUrl,
        discoveredRoutes: ctx.discoveredRoutes,
        visitedRoutes: ctx.visitedRoutes,
        actionInventory: ctx.actionInventory,
        environmentChecks: ctx.environmentChecks,
        accessMap: ctx.accessMap,
      };
      if (executor) {
        try {
          await executor.execute(task, ctx);
          // Persist any newly discovered API endpoints back to session state
          // so subsequent tasks (API executor) can use them
          if (ctx.discoveredApiEndpoints && ctx.discoveredApiEndpoints !== before.discoveredApiEndpoints) {
            const existing = new Set(state.discoveredApiEndpoints ?? []);
            for (const e of ctx.discoveredApiEndpoints) existing.add(e);
            state.discoveredApiEndpoints = [...existing];
          }
          if (ctx.postLoginUrl && ctx.postLoginUrl !== before.postLoginUrl) {
            state.postLoginUrl = ctx.postLoginUrl;
          }
          if (ctx.discoveredRoutes && ctx.discoveredRoutes !== before.discoveredRoutes) {
            const existing = new Set(state.discoveredRoutes ?? []);
            for (const r of ctx.discoveredRoutes) existing.add(r);
            state.discoveredRoutes = [...existing];
          }
          if (ctx.visitedRoutes && ctx.visitedRoutes !== before.visitedRoutes) {
            state.visitedRoutes = ctx.visitedRoutes;
          }
          if (ctx.environmentChecks && ctx.environmentChecks !== before.environmentChecks) {
            state.environmentChecks = ctx.environmentChecks;
          }
          if (ctx.accessMap && ctx.accessMap !== before.accessMap) {
            state.accessMap = ctx.accessMap;
          }
          if (ctx.actionInventory && ctx.actionInventory !== before.actionInventory) {
            const mergedEntries = [
              ...(state.actionInventory?.entries ?? []),
              ...ctx.actionInventory.entries,
            ];
            const byResult: Record<string, number> = {};
            for (const e of mergedEntries) byResult[e.result] = (byResult[e.result] ?? 0) + 1;
            state.actionInventory = {
              totalFound: (state.actionInventory?.totalFound ?? 0) + ctx.actionInventory.totalFound,
              totalTested: (state.actionInventory?.totalTested ?? 0) + ctx.actionInventory.totalTested,
              totalSkippedRisky:
                (state.actionInventory?.totalSkippedRisky ?? 0) + ctx.actionInventory.totalSkippedRisky,
              byResult,
              entries: mergedEntries,
            };
          }
        } catch (err) {
          ctx.onLog(`Task failed: ${(err as Error).message}`);
        }
      }

      // Failure isolation: did this task fail with the same page-load-timeout signature as
      // the target being down/slow, rather than a real app defect?
      const newFindingsThisTask = state.findings.slice(findingsCountBeforeTask);
      const hadTimeoutFailure = newFindingsThisTask.some(
        (f) => f.area === 'UI-Error' && TIMEOUT_SIGNATURE.test(f.actual),
      );
      consecutiveTimeoutFailures = hadTimeoutFailure ? consecutiveTimeoutFailures + 1 : 0;

      if (consecutiveTimeoutFailures >= ENV_DEGRADED_THRESHOLD && !envDegradedNoted) {
        envDegradedNoted = true;
        // Retroactively quarantine the individual "Task error" findings that make up this
        // streak — they're symptoms of one environmental issue, not N separate app defects —
        // and replace them with a single clear note. computeHealthScore already skips
        // quarantined findings, so this also stops one bad stretch from tanking the score.
        let quarantinedCount = 0;
        for (let i = state.findings.length - 1; i >= 0 && quarantinedCount < consecutiveTimeoutFailures; i--) {
          const f = state.findings[i];
          if (f.area === 'UI-Error' && TIMEOUT_SIGNATURE.test(f.actual) && !f.quarantineReason) {
            f.severity = 'info';
            f.quarantineReason =
              'Part of a streak of consecutive page-load timeouts — likely the target site was ' +
              'slow or briefly unavailable during this window, not an application defect';
            f.tags = [...new Set([...(f.tags ?? []), 'env-degraded'])];
            quarantinedCount++;
          }
        }
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Environment',
          title: `Target site appears to have been unavailable or slow for ${consecutiveTimeoutFailures} consecutive checks`,
          steps: [
            `Re-run this session against ${state.config.targetUrl} when the target is confirmed reachable`,
            'Compare whether the same checks still fail',
          ],
          expected: 'The target application responds within normal load times',
          actual:
            `${consecutiveTimeoutFailures} consecutive tasks failed with a page-load timeout. ` +
            'The individual findings from this streak have been downgraded to info and marked ' +
            'as environment-related — treat them as inconclusive, not confirmed defects, until ' +
            're-run against a healthy target.',
          evidence: [],
          reproRate: 'N/A',
          automationCandidate: false,
        });
        ctx.onLog(
          `[Env] Target appears degraded after ${consecutiveTimeoutFailures} consecutive timeouts — ` +
            'remaining tasks will use a shorter timeout budget',
        );
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
      // Fingerprint findings and diff against the previous run against the same target,
      // so the report can show a New / Fixed / Recurring breakdown.
      state.findings = attachFingerprints(state.findings);
      const prevGeneric = await loadPreviousSessionFindings(
        sessionsDir,
        state.config.targetUrl,
        sessionId,
      );
      if (prevGeneric) {
        state.findingDiff = diffFindingFingerprints(
          state.findings,
          prevGeneric.findings,
          prevGeneric.sessionId,
        );
        this.emit({
          type: 'log',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            message:
              `[Regression] Finding diff vs previous session (${prevGeneric.sessionId.slice(0, 8)}): ` +
              `+${state.findingDiff.newFindings.length} new, -${state.findingDiff.fixedFindings.length} fixed, ` +
              `${state.findingDiff.recurringFindings.length} recurring`,
          },
        });
      }

      state.status = 'completed';
      state.progress.percent = 100;
      state.updatedAt = new Date().toISOString();
      await saveSessionState(sessionsDir, state);
      try {
        await writeSessionReport(sessionsDir, state);
      } catch (err) {
        // Report generation must not fail the session; surface in logs via emit
        this.emit({
          type: 'log',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            message: `Report generation failed: ${(err as Error).message}`,
          },
        });
      }
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
