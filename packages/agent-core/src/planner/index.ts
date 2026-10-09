import { randomUUID } from 'node:crypto';
import type {
  ExplorationArea,
  ExplorationPlan,
  FlowTask,
  PlanPhase,
  SessionConfig,
  SessionDepth,
  SiteClassification,
  SiteIntelligenceSignals,
} from '@qa/shared';
import { FLOW_CLASSES, FLOW_TITLES, GENERIC_PHASES } from '@qa/shared';
import { expandRequirementWithAI } from '../intelligence/requirement-expand-ai.js';

// standard's cap must stay comfortably above the total flow-class count across ALL_AREAS
// (94 as of 2026-10-06: ui 52 + chaos 10 + api 19 + security 2 + performance 4 + regression 3
// + accessibility 3 + 1 recon) — otherwise it silently becomes the real constraint on coverage:
// every new check added anywhere just displaces an existing one out of the same fixed budget,
// so the scheduled-task count never visibly grows no matter how much real detection logic gets
// built. Re-check this against the catalog total whenever a new flow class is added; it should
// never be the thing deciding which checks run.
const DEPTH_TASK_LIMITS: Record<SessionDepth, number> = {
  smoke: 15,     // recon + core UI + chaos basics
  standard: 130, // all matrix flows across all areas, with headroom for catalog growth
  deep: 200,     // full matrix + duplicates for extra coverage
  chaos: 20,     // all chaos + session + network flows
};

function tasksForArea(area: keyof typeof FLOW_CLASSES, startPriority: number): FlowTask[] {
  const flows = FLOW_CLASSES[area];
  return flows.map((flowClass, i) => ({
    id: `${area}-${flowClass}`,
    area,
    flowClass,
    title: FLOW_TITLES[flowClass] ?? flowClass,
    description: `Explore ${flowClass} on target application`,
    priority: startPriority + i,
  }));
}

/**
 * All areas that are always explored by default.
 * 'accessibility' (labels, keyboard focus visibility, colour contrast) now has real
 * FLOW_HANDLERS entries (see accessibility.ts) and is included by default.
 */
const ALL_AREAS: (keyof typeof FLOW_CLASSES)[] = [
  'ui',
  'chaos',
  'api',
  'security',
  'performance',
  'regression',
  'accessibility',
];

// Real risk scoring, not just insertion order. This matters for one concrete reason:
// `limitedTasks = tasks.slice(0, limit)` below means at smoke depth (15 tasks) or even
// standard (80), whichever flow classes happen to sit earlier in FLOW_CLASSES survive the
// cut — a cosmetic dark-mode check could bump a real auth-bypass probe off the plan purely
// by array position, with nothing about actual risk involved. This scores each flow class by
// business impact (auth/security bypass), data-mutation risk, and session-integrity
// sensitivity, and sorts by it before slicing — so budget-constrained runs spend their task
// count on what's actually likely to matter first.
const CRITICAL_RISK = new Set([
  'auth-matrix', 'auth-bypass', 'idor-probe', 'horizontal-privilege', 'vertical-privilege',
  'mass-assignment', 'xss-probe', 'security-headers', 'hidden-route-access',
  'token-validation', // invalid/malformed/expired-token bypass + JWT alg:none — same class as auth-matrix
]);
const HIGH_RISK = new Set([
  'crud', 'journey', 'data-integrity', 'state-transition', 'business-logic-boundary', 'rate-limit',
  'session-timeout', 'multi-tab-logout', 'logout-session', 'session-expires-mid-op', 'deep-link', 'schema-drift', 'generic-crud',
  'cancel-creation', 'cancel-deletion', 'duplicate-creation',
  'crud-lifecycle', 'concurrency', 'malformed-input', 'state-transition-api', 'request-ordering',
]);
const LOW_RISK = new Set([
  'dark-mode', 'reduced-motion', 'rtl-layout', 'placeholder-check', 'broken-images',
  'element-overflow', 'zoom-reflow', 'cross-browser', 'device-matrix', 'toast-stacking',
  'long-content', 'locale-format', 'bfcache', 'coverage-report', 'web-vitals',
]);

function riskWeight(flowClass: string): number {
  if (flowClass === 'recon') return 100; // always first, not part of the risk ordering below
  if (CRITICAL_RISK.has(flowClass)) return 10;
  if (HIGH_RISK.has(flowClass)) return 8;
  if (LOW_RISK.has(flowClass)) return 2;
  return 5; // everything else — form validation, boundary, navigation, chaos, a11y, perf — a reasonable middle
}

/** Area lookup for a given flow class */
function areaForFlow(fc: string): ExplorationArea {
  const chaosFlows = new Set(FLOW_CLASSES.chaos as readonly string[]);
  const apiFlows = new Set(FLOW_CLASSES.api as readonly string[]);
  const secFlows = new Set(FLOW_CLASSES.security as readonly string[]);
  const a11yFlows = new Set(FLOW_CLASSES.accessibility as readonly string[]);
  const perfFlows = new Set(FLOW_CLASSES.performance as readonly string[]);
  const regFlows = new Set(FLOW_CLASSES.regression as readonly string[]);
  if (chaosFlows.has(fc)) return 'chaos';
  if (apiFlows.has(fc)) return 'api';
  if (secFlows.has(fc)) return 'security';
  if (a11yFlows.has(fc)) return 'accessibility';
  if (perfFlows.has(fc)) return 'performance';
  if (regFlows.has(fc)) return 'regression';
  return 'ui';
}

export function buildGenericPlan(sessionId: string, config: SessionConfig): ExplorationPlan {
  let priority = 0;
  const tasks: FlowTask[] = [];

  // Recon always runs first
  tasks.push({
    id: 'recon-site-map',
    area: 'ui',
    flowClass: 'recon',
    title: 'Site reconnaissance',
    description: 'Map URLs, forms, links, and API calls, classify site type',
    priority: priority++,
  });

  if (config.selectedFlowClasses && config.selectedFlowClasses.length > 0) {
    // User explicitly chose specific matrix tests — run only those
    for (const fc of config.selectedFlowClasses) {
      tasks.push({
        id: `selected-${fc}`,
        area: areaForFlow(fc),
        flowClass: fc,
        title: FLOW_TITLES[fc] ?? fc,
        description: `Run ${FLOW_TITLES[fc] ?? fc}`,
        priority: priority++,
      });
    }
  } else {
    // Default: run ALL matrix flows across all areas, ordered by priority
    // Smoke runs only the core UI set; standard/deep/chaos run everything
    const depthAreas: (keyof typeof FLOW_CLASSES)[] =
      config.depth === 'smoke'
        ? ['ui', 'chaos']
        : config.depth === 'chaos'
          ? ['chaos', 'ui']
          : ALL_AREAS;

    for (const area of depthAreas) {
      const areaTasks = tasksForArea(area, priority);
      tasks.push(...areaTasks);
      priority += areaTasks.length;
    }

    // Stable sort (ties keep their original area/FLOW_CLASSES order) by descending risk —
    // recon (weight 100) stays first automatically, everything else reorders by actual risk
    // instead of array position. Re-numbering `priority` afterward keeps it meaningful rather
    // than leaving stale pre-sort values on the field.
    tasks.sort((a, b) => riskWeight(b.flowClass) - riskWeight(a.flowClass));
    tasks.forEach((t, i) => { t.priority = i; });
  }

  const limit = DEPTH_TASK_LIMITS[config.depth];
  const limitedTasks = tasks.slice(0, limit);

  const phases: PlanPhase[] = GENERIC_PHASES.map((phase) => ({
    id: phase.id,
    name: phase.name,
    description: phase.description,
    taskIds: limitedTasks
      .filter((t) => {
        if (phase.id === 'recon') return t.flowClass === 'recon';
        if (phase.id === 'smoke')
          return ['navigation', 'crud', 'journey', 'user-directed', 'action-inventory', 'data-integrity', 'state-transition', 'consent-exploration', 'visual-review', 'agentic-explore', 'generic-crud', 'cancel-creation', 'cancel-deletion', 'duplicate-creation'].includes(t.flowClass);
        if (phase.id === 'boundary')
          return [
            'form-validation',
            'input-boundary',
            'boundary',
            'pagination',
            'pagination-ui',
            'error-ui',
            'file-upload',
            'autofill',
            'modal-lifecycle',
            'dropdown-exploration',
            'browser-behavior',
            'interactive-states',
            'field-validation',
            'table-interaction',
            'viewport',
            'business-logic-boundary',
            'functional-listing',
            'zoom-reflow',
            'dark-mode',
            'reduced-motion',
            'autofill-overlap',
            'long-content',
            'rtl-layout',
            'placeholder-check',
            'broken-images',
            'element-overflow',
            'locale-format',
          ].includes(t.flowClass);
        if (phase.id === 'interruption')
          return [
            'back-during-post',
            'refresh-during-request',
            'cancel-during-loading',
            'navigate-away-during-loading',
            'double-click',
            'forward-after-back',
            'deep-link',
            'session-timeout',
            'multi-tab-logout',
            'logout-session',
            'forgot-password',
            'session-expires-mid-op',
            'wizard',
            'focus-trap',
            'bfcache',
            'concurrent-edit',
          ].includes(t.flowClass);
        if (phase.id === 'auth')
          return [
            'auth-matrix',
            'auth-bypass',
            'idor-probe',
            'horizontal-privilege',
            'vertical-privilege',
            'mass-assignment',
            'hidden-route-access',
          ].includes(t.flowClass);
        if (phase.id === 'chaos')
          return [
            'slow-network',
            'offline-mid-request',
            'offline-recovery',
            'double-submit',
            'flaky-network',
            'timeout-retry',
            'websocket-disconnect',
            'cpu-throttle',
            'offline-pwa',
          ].includes(t.flowClass);
        if (phase.id === 'report')
          return [
            'golden-path',
            'visual-regression',
            'schema-drift',
            'spike-load',
            'load-time',
            'large-payload',
            'n-plus-one',
            'xss-probe',
            'security-headers',
            'rate-limit',
            'idempotency',
            'response-hygiene',
            'http-method-validation',
            'malformed-input',
            'crud-lifecycle',
            'concurrency',
            'file-payload',
            'async-operations',
            'token-validation',
            'token-refresh',
            'error-consistency',
            'status-code-validation',
            'request-ordering',
            'state-transition-api',
            'labels',
            'keyboard',
            'contrast',
            'semantic-structure',
            'cross-browser',
            'device-matrix',
            'download-verify',
            'toast-stacking',
            'js-errors',
            'coverage-report',
            'web-vitals',
          ].includes(t.flowClass);
        return false;
      })
      .map((t) => t.id),
  })).filter((p) => p.taskIds.length > 0);

  return {
    sessionId,
    phases,
    tasks: limitedTasks,
    generatedAt: new Date().toISOString(),
  };
}

export async function buildPlanFromContext(
  sessionId: string,
  config: SessionConfig,
): Promise<ExplorationPlan> {
  const base = buildGenericPlan(sessionId, config);

  if (config.context) {
    // Requirement-aware exploration: try to expand the free-text context into specific
    // boundary-condition instructions (see requirement-expand-ai.ts) before falling back to
    // naive sentence-splitting. Both paths route to 'user-directed' — NOT 'context-driven',
    // which is aliased to plain runNavigation in ui-executor.ts and silently ignored the
    // actual sentence content entirely; the old fallback here was a no-op beyond a task
    // title, fixed as part of the same change rather than left broken under the new path.
    const aiInstructions = await expandRequirementWithAI(config.context).catch(() => null);
    const instructions =
      aiInstructions ??
      config.context
        .split(/[.\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10)
        .slice(0, 5);

    const contextTasks: FlowTask[] = instructions.map((instruction, i) => ({
      id: `context-${randomUUID().slice(0, 8)}`,
      area: 'ui' as const,
      flowClass: 'user-directed',
      title: `Context flow: ${instruction.slice(0, 60)}${instruction.length > 60 ? '...' : ''}`,
      description: instruction,
      priority: i,
    }));

    base.tasks = [...contextTasks, ...base.tasks];
    if (contextTasks.length > 0) {
      base.phases.unshift({
        id: 'context',
        name: 'Context-driven',
        description: aiInstructions
          ? 'Requirement-aware boundary/edge-case instructions derived from user-provided context'
          : 'Flows derived from user-provided context',
        taskIds: contextTasks.map((t) => t.id),
      });
    }
  }

  return base;
}

/**
 * Called once real recon signals are in, for tasks that are already queued but haven't
 * run yet — the depth-tier limit (DEPTH_TASK_LIMITS) already truncated the FULL matrix down
 * to a fixed budget before recon ever ran, purely by hardcoded array order, so at
 * smoke/standard depth over half the matrix can get cut for reasons that have nothing to do
 * with the actual site. This can't fix which tasks already made that cut, but it CAN stop
 * spending remaining budget on the ones we now have real evidence are pointless (e.g.
 * testing file-upload edge cases on a page with no file input) — freeing that time for
 * whatever's left, and directly avoiding the "clearly not applicable" output that made past
 * runs look generic. Recon only samples the landing page, so this is evidence, not proof —
 * a real file input could still live on some other page — hence removing only the two flows
 * where recon's signal is unambiguous, not guessing broadly.
 */
export function removeUnlikelyTasks(plan: ExplorationPlan, signals: SiteIntelligenceSignals): void {
  const hasFileInput = signals.inputTypes.includes('file');
  const looksPaginated =
    signals.urlPaths.some((p) => /page=|\/page\//i.test(p)) ||
    signals.buttonTexts.some((t) => /\b(next|previous|prev)\b/i.test(t)) ||
    signals.linkTexts.some((t) => /^\d+$/.test(t.trim()));
  const hasAutofillProneInput =
    signals.inputTypes.includes('email') || signals.inputTypes.includes('password');
  const looksDownloadable =
    signals.buttonTexts.some((t) => /\b(download|export)\b/i.test(t)) ||
    signals.linkTexts.some((t) => /\b(download|export)\b/i.test(t));

  const toRemove = new Set(
    plan.tasks
      .filter(
        (t) =>
          (t.flowClass === 'file-upload' && !hasFileInput) ||
          (t.flowClass === 'pagination-ui' && !looksPaginated) ||
          (t.flowClass === 'autofill-overlap' && !hasAutofillProneInput) ||
          (t.flowClass === 'download-verify' && !looksDownloadable),
      )
      .map((t) => t.id),
  );
  if (toRemove.size === 0) return;

  plan.tasks = plan.tasks.filter((t) => !toRemove.has(t.id));
  for (const phase of plan.phases) {
    phase.taskIds = phase.taskIds.filter((id) => !toRemove.has(id));
  }
  plan.phases = plan.phases.filter((p) => p.taskIds.length > 0);
}

export function injectJourneyTasks(
  plan: ExplorationPlan,
  classification: SiteClassification,
): ExplorationPlan {
  if (classification.confidence < 0.3) return plan;

  const journeyTasks: FlowTask[] = classification.inferredJourneys.map((journey, i) => ({
    id: `journey-${i}-${randomUUID().slice(0, 6)}`,
    area: 'ui' as const,
    flowClass: 'journey',
    title: journey,
    description: `[${classification.siteType}] ${journey}`,
    priority: -(100 - i),
  }));

  // Add a single grouped journey task that runs all flows for the classified type
  const journeyPhaseTask: FlowTask = {
    id: `journey-phase-${randomUUID().slice(0, 6)}`,
    area: 'ui' as const,
    flowClass: 'journey',
    title: `${classification.siteType} user journeys`,
    description: `Run domain-specific journeys for ${classification.siteType}: ${classification.inferredJourneys.join(', ')}`,
    priority: -50,
  };

  plan.tasks = [journeyPhaseTask, ...plan.tasks];
  plan.phases.unshift({
    id: 'journeys',
    name: 'Domain Journeys',
    description: `Site classified as ${classification.siteType} (${Math.round(classification.confidence * 100)}% confidence) — running matched user journeys`,
    taskIds: [journeyPhaseTask.id],
  });

  return plan;
}

export async function buildPlan(
  sessionId: string,
  config: SessionConfig,
  classification?: SiteClassification,
): Promise<ExplorationPlan> {
  const plan = await buildPlanFromContext(sessionId, config);

  // User-directed flow instructions get highest priority
  if (config.flowInstructions && config.flowInstructions.length > 0) {
    const userTasks: FlowTask[] = config.flowInstructions.map((instruction, i) => ({
      id: `user-directed-${i}-${randomUUID().slice(0, 6)}`,
      area: 'ui' as const,
      flowClass: 'user-directed',
      title: instruction.length > 60 ? `${instruction.slice(0, 57)}...` : instruction,
      description: instruction,
      priority: -(200 - i),
    }));

    plan.tasks = [...userTasks, ...plan.tasks];
    plan.phases.unshift({
      id: 'user-directed',
      name: 'User-directed flows',
      description: 'Flows explicitly requested by the user',
      taskIds: userTasks.map((t) => t.id),
    });
  }

  if (classification) {
    injectJourneyTasks(plan, classification);
  }

  return plan;
}

