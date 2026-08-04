import { randomUUID } from 'node:crypto';
import type {
  ExplorationArea,
  ExplorationPlan,
  FlowTask,
  PlanPhase,
  SessionConfig,
  SessionDepth,
  SiteClassification,
} from '@qa/shared';
import { FLOW_CLASSES, FLOW_TITLES, GENERIC_PHASES } from '@qa/shared';

const DEPTH_TASK_LIMITS: Record<SessionDepth, number> = {
  smoke: 15,     // recon + core UI + chaos basics
  standard: 80,  // all matrix flows across all areas
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
 * All areas that are always explored by default (standard/deep depth).
 * Accessibility is included now that E1–E3 have real FLOW_HANDLERS
 * (labels / keyboard / contrast) — not the navigation fallback.
 */
const ALL_AREAS: (keyof typeof FLOW_CLASSES)[] = [
  'ui',
  'chaos',
  'api',
  'security',
  'accessibility',
  'performance',
  'regression',
];

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

/** True when the user picked specific matrix IDs (e.g. "run E1, E2, E3"). */
export function isTargetedMatrixRun(config: SessionConfig): boolean {
  return Boolean(config.selectedFlowClasses && config.selectedFlowClasses.length > 0);
}

export function buildGenericPlan(sessionId: string, config: SessionConfig): ExplorationPlan {
  let priority = 0;
  const tasks: FlowTask[] = [];

  if (isTargetedMatrixRun(config)) {
    // Targeted run: ONLY the selected matrix tests — no recon, journeys, or extras.
    for (const fc of config.selectedFlowClasses!) {
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
    // Recon always runs first on a full / area-based plan
    tasks.push({
      id: 'recon-site-map',
      area: 'ui',
      flowClass: 'recon',
      title: 'Site reconnaissance',
      description: 'Map URLs, forms, links, and API calls, classify site type',
      priority: priority++,
    });

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
  }

  const limit = DEPTH_TASK_LIMITS[config.depth];
  const limitedTasks = tasks.slice(0, limit);

  // Targeted matrix runs get a single clear phase (not buried under "report")
  if (isTargetedMatrixRun(config)) {
    return {
      sessionId,
      phases: [
        {
          id: 'selected',
          name: 'Selected matrix tests',
          description: `Running ${limitedTasks.length} explicitly selected test(s) only`,
          taskIds: limitedTasks.map((t) => t.id),
        },
      ],
      tasks: limitedTasks,
      generatedAt: new Date().toISOString(),
    };
  }

  const phases: PlanPhase[] = GENERIC_PHASES.map((phase) => ({
    id: phase.id,
    name: phase.name,
    description: phase.description,
    taskIds: limitedTasks
      .filter((t) => {
        if (phase.id === 'recon') return t.flowClass === 'recon';
        if (phase.id === 'smoke')
          return ['navigation', 'crud', 'journey', 'user-directed'].includes(t.flowClass);
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
            'viewport',
          ].includes(t.flowClass);
        if (phase.id === 'interruption')
          return [
            'back-during-post',
            'refresh-during-request',
            'double-click',
            'forward-after-back',
            'deep-link',
            'session-timeout',
            'multi-tab-logout',
            'wizard',
          ].includes(t.flowClass);
        if (phase.id === 'auth')
          return [
            'auth-matrix',
            'auth-bypass',
            'idor-probe',
            'horizontal-privilege',
            'vertical-privilege',
            'mass-assignment',
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
            'rate-limit',
            'idempotency',
            'labels',
            'keyboard',
            'contrast',
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

export function buildPlanFromContext(
  sessionId: string,
  config: SessionConfig,
): ExplorationPlan {
  const base = buildGenericPlan(sessionId, config);

  if (config.context) {
    const contextTasks: FlowTask[] = config.context
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10)
      .slice(0, 5)
      .map((sentence, i) => ({
        id: `context-${randomUUID().slice(0, 8)}`,
        area: 'ui' as const,
        flowClass: 'context-driven',
        title: `Context flow: ${sentence.slice(0, 60)}...`,
        description: sentence,
        priority: i,
      }));

    base.tasks = [...contextTasks, ...base.tasks];
    if (contextTasks.length > 0) {
      base.phases.unshift({
        id: 'context',
        name: 'Context-driven',
        description: 'Flows derived from user-provided context',
        taskIds: contextTasks.map((t) => t.id),
      });
    }
  }

  return base;
}

export function injectJourneyTasks(
  plan: ExplorationPlan,
  classification: SiteClassification,
  /** When set, skip injection for targeted matrix runs ("run E1, E2, E3"). */
  config?: SessionConfig,
): ExplorationPlan {
  if (config && isTargetedMatrixRun(config)) return plan;
  if (classification.confidence < 0.3) return plan;

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

export function buildPlan(
  sessionId: string,
  config: SessionConfig,
  prdFeatures?: string[],
  classification?: SiteClassification,
  prdConstraints?: string[],
  prdFeatureCriteria?: string[],
): ExplorationPlan {
  // ── PRD-only mode ──────────────────────────────────────────────────────────
  // When a PRD was uploaded, run ONLY feature-focused QA (happy / negative /
  // interruption). Do NOT run the generic A1–H3 matrix.
  if (prdFeatures && prdFeatures.length > 0) {
    return buildPrdOnlyPlan(
      sessionId,
      config,
      prdFeatures,
      prdConstraints ?? [],
      prdFeatureCriteria ?? [],
    );
  }

  const plan = buildPlanFromContext(sessionId, config);

  // Targeted matrix selection ("run E1, E2, E3") → selected tests only.
  // Skip user-directed duplicates and domain journeys.
  if (isTargetedMatrixRun(config)) {
    return plan;
  }

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
    injectJourneyTasks(plan, classification, config);
  }

  return plan;
}

/**
 * Build a QA plan from PRD features only.
 * For each feature: happy path + negative/empty/invalid + interruption (back/refresh).
 */
export function buildPrdOnlyPlan(
  sessionId: string,
  config: SessionConfig,
  features: string[],
  constraints: string[],
  featureCriteria: string[] = [],
): ExplorationPlan {
  const tasks: FlowTask[] = [
    {
      id: 'recon-site-map',
      area: 'ui',
      flowClass: 'recon',
      title: 'Site reconnaissance (PRD context)',
      description: 'Map the site so PRD feature tests can locate UI elements',
      priority: 0,
    },
    {
      id: 'prd-auth-smoke',
      area: 'ui',
      flowClass: 'prd-driven',
      title: 'PRD auth smoke gate',
      description:
        'Fail fast if session restore / post-login landing is broken before deep PRD feature tests',
      priority: 1,
      meta: {
        prdFeature: 'Auth smoke gate',
        prdVariant: 'happy',
        prdRequirementId: 'SMOKE',
        isAuthSmoke: true,
      },
    },
  ];

  const limited = features.slice(0, 12);
  const variants: Array<{ variant: 'happy' | 'negative' | 'interruption'; label: string }> = [
    { variant: 'happy', label: 'Happy path' },
    { variant: 'negative', label: 'Negative / empty / invalid' },
    { variant: 'interruption', label: 'Interruption (back / refresh)' },
  ];

  let priority = 2;
  const prdTaskIds: string[] = ['prd-auth-smoke'];

  for (let i = 0; i < limited.length; i++) {
    const feature = limited[i];
    const requirementId = `F${i + 1}`;
    for (const { variant, label } of variants) {
      const id = `prd-${i}-${variant}`;
      prdTaskIds.push(id);
      tasks.push({
        id,
        area: 'ui',
        flowClass: 'prd-driven',
        title: `PRD [${requirementId}][${label}]: ${feature.slice(0, 60)}`,
        description: feature,
        priority: priority++,
        meta: {
          prdFeature: feature,
          prdVariant: variant,
          prdConstraints: constraints.slice(0, 10),
          prdRequirementId: requirementId,
          prdCriteria: featureCriteria[i]?.slice(0, 180),
        },
      });
    }
  }

  // Optional user-directed extras still allowed alongside PRD
  if (config.flowInstructions && config.flowInstructions.length > 0) {
    for (let i = 0; i < config.flowInstructions.length; i++) {
      const instruction = config.flowInstructions[i];
      tasks.push({
        id: `user-directed-${i}-${randomUUID().slice(0, 6)}`,
        area: 'ui',
        flowClass: 'user-directed',
        title: instruction.length > 60 ? `${instruction.slice(0, 57)}...` : instruction,
        description: instruction,
        priority: priority++,
      });
    }
  }

  const phases: PlanPhase[] = [
    {
      id: 'recon',
      name: 'Recon',
      description: 'Map site structure for PRD feature discovery',
      taskIds: ['recon-site-map'],
    },
    {
      id: 'prd',
      name: 'PRD-driven QA',
      description: `Auth smoke + ${limited.length} PRD feature(s) — happy, negative, interruption (generic matrix skipped)`,
      taskIds: prdTaskIds,
    },
  ];

  return {
    sessionId,
    phases,
    tasks,
    generatedAt: new Date().toISOString(),
  };
}

