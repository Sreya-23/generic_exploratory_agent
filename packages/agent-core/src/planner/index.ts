import { randomUUID } from 'node:crypto';
import type {
  ExplorationPlan,
  FlowTask,
  PlanPhase,
  SessionConfig,
  SessionDepth,
  SiteClassification,
} from '@qa/shared';
import { FLOW_CLASSES, GENERIC_PHASES } from '@qa/shared';

const DEPTH_TASK_LIMITS: Record<SessionDepth, number> = {
  smoke: 8,
  standard: 20,
  deep: 50,
  chaos: 15,
};

const FLOW_TITLES: Record<string, string> = {
  navigation: 'Happy path navigation',
  'form-validation': 'Form validation edge cases',
  'input-boundary': 'Input boundary values',
  'double-click': 'Double / rapid click actions',
  'modal-lifecycle': 'Modal and drawer lifecycle',
  'empty-states': 'Empty and loading states',
  'keyboard-nav': 'Keyboard navigation',
  crud: 'CRUD completeness',
  'auth-matrix': 'Authentication matrix',
  pagination: 'Pagination edge cases',
  boundary: 'API boundary values',
  idempotency: 'Idempotency checks',
  'rate-limit': 'Rate limiting behavior',
  'slow-network': 'Slow network (3G simulation)',
  'offline-mid-request': 'Offline mid-request',
  'offline-recovery': 'Offline to online recovery',
  'back-during-post': 'Browser back during POST',
  'refresh-during-request': 'Refresh during in-flight request',
  'double-submit': 'Double submit on slow response',
  'idor-probe': 'IDOR probe',
  'auth-bypass': 'Auth bypass probe',
  'xss-probe': 'XSS input probe',
  labels: 'Screen reader labels',
  keyboard: 'Keyboard accessibility',
  contrast: 'Color contrast check',
  'load-time': 'Page load time',
  'large-payload': 'Large payload handling',
  'golden-path': 'Golden path regression',
  'api-schema-drift': 'API schema drift detection',
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

export function buildGenericPlan(sessionId: string, config: SessionConfig): ExplorationPlan {
  const areas = config.areas.length > 0 ? config.areas : (['ui'] as const);
  let priority = 0;
  const tasks: FlowTask[] = [];

  tasks.push({
    id: 'recon-site-map',
    area: 'ui',
    flowClass: 'recon',
    title: 'Site reconnaissance',
    description: 'Map URLs, forms, links, and API calls',
    priority: priority++,
  });

  for (const area of areas) {
    if (area in FLOW_CLASSES) {
      const areaTasks = tasksForArea(area as keyof typeof FLOW_CLASSES, priority);
      tasks.push(...areaTasks);
      priority += areaTasks.length;
    }
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
          return ['navigation', 'crud'].includes(t.flowClass);
        if (phase.id === 'boundary')
          return ['form-validation', 'input-boundary', 'boundary', 'pagination'].includes(
            t.flowClass,
          );
        if (phase.id === 'interruption')
          return ['back-during-post', 'refresh-during-request', 'double-click'].includes(
            t.flowClass,
          );
        if (phase.id === 'auth')
          return ['auth-matrix', 'auth-bypass', 'idor-probe'].includes(t.flowClass);
        if (phase.id === 'chaos')
          return [
            'slow-network',
            'offline-mid-request',
            'offline-recovery',
            'double-submit',
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

export function buildPlan(
  sessionId: string,
  config: SessionConfig,
  prdFeatures?: string[],
  classification?: SiteClassification,
): ExplorationPlan {
  const plan = buildPlanFromContext(sessionId, config);

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

  if (prdFeatures && prdFeatures.length > 0) {
    const prdTasks: FlowTask[] = prdFeatures.slice(0, 10).map((feature, i) => ({
      id: `prd-${i}`,
      area: 'ui' as const,
      flowClass: 'prd-driven',
      title: `PRD: ${feature.slice(0, 80)}`,
      description: feature,
      priority: -10 + i,
    }));

    plan.tasks = [...prdTasks, ...plan.tasks];
    plan.phases.unshift({
      id: 'prd',
      name: 'PRD-driven',
      description: 'Flows extracted from uploaded PRD',
      taskIds: prdTasks.map((t) => t.id),
    });
  }

  if (classification) {
    injectJourneyTasks(plan, classification);
  }

  return plan;
}
