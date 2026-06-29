import type { ExplorationArea, SessionDepth } from './types.js';

export const EXPLORATION_AREAS: {
  id: ExplorationArea;
  label: string;
  description: string;
}[] = [
  {
    id: 'ui',
    label: 'UI & Interaction',
    description: 'Navigation, forms, modals, keyboard, viewport',
  },
  {
    id: 'api',
    label: 'API Testing',
    description: 'CRUD, auth matrix, boundaries, idempotency',
  },
  {
    id: 'chaos',
    label: 'Chaos & Resilience',
    description: 'Network failures, back button mid-request, double-click',
  },
  {
    id: 'regression',
    label: 'Regression',
    description: 'Compare against baseline snapshots',
  },
  {
    id: 'security',
    label: 'Security Spot-check',
    description: 'IDOR, privilege escalation, XSS probes',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'Labels, contrast, keyboard navigation',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Load times, large payloads, spike patterns',
  },
];

export const SESSION_DEPTHS: {
  id: SessionDepth;
  label: string;
  description: string;
  estimatedMinutes: number;
}[] = [
  {
    id: 'smoke',
    label: 'Quick / Smoke',
    description: 'Critical paths and top interruptions (~30 min)',
    estimatedMinutes: 30,
  },
  {
    id: 'standard',
    label: 'Standard',
    description: 'PRD flows + generic baseline (~1-2 hrs)',
    estimatedMinutes: 90,
  },
  {
    id: 'deep',
    label: 'Deep',
    description: 'Full exploration catalog for selected areas (~3-6 hrs)',
    estimatedMinutes: 240,
  },
  {
    id: 'chaos',
    label: 'Chaos Focus',
    description: 'Interruption and network resilience suite (~1 hr)',
    estimatedMinutes: 60,
  },
];

export const GENERIC_PHASES = [
  { id: 'recon', name: 'Recon', description: 'Map URLs, routes, forms, API calls' },
  { id: 'smoke', name: 'Smoke', description: 'Happy path per major feature' },
  { id: 'boundary', name: 'Boundary Sweep', description: 'Input limits on forms and APIs' },
  { id: 'interruption', name: 'Interruption Suite', description: 'Back, refresh, offline mid-action' },
  { id: 'auth', name: 'Auth & Security', description: 'Auth matrix and spot checks' },
  { id: 'chaos', name: 'Chaos', description: 'Flaky network and rapid actions' },
  { id: 'report', name: 'Report', description: 'Dedupe and generate findings' },
] as const;

export const FLOW_CLASSES = {
  ui: [
    'navigation',
    'form-validation',
    'input-boundary',
    'double-click',
    'modal-lifecycle',
    'empty-states',
    'keyboard-nav',
  ],
  api: ['crud', 'auth-matrix', 'pagination', 'boundary', 'idempotency', 'rate-limit'],
  chaos: [
    'slow-network',
    'offline-mid-request',
    'offline-recovery',
    'back-during-post',
    'refresh-during-request',
    'double-submit',
  ],
  security: ['idor-probe', 'auth-bypass', 'xss-probe'],
  accessibility: ['labels', 'keyboard', 'contrast'],
  performance: ['load-time', 'large-payload'],
  regression: ['golden-path', 'api-schema-drift'],
} as const;
