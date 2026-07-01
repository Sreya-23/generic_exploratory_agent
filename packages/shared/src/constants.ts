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
    // A1 – A5
    'navigation',
    'form-validation',
    'input-boundary',
    'double-click',
    'modal-lifecycle',
    'empty-states',
    'keyboard-nav',
    // A6 — Scroll & Viewport
    'viewport',
    // A9 — Error UI
    'error-ui',
    // A10 — Copy/Paste & Autofill
    'autofill',
    // A11 — File Upload
    'file-upload',
    // A12 — Pagination UI
    'pagination-ui',
    // A13 — Multi-step Wizard
    'wizard',
    // B2-B7 — Session & Navigation
    'forward-after-back',
    'deep-link',
    'session-timeout',
    'multi-tab-logout',
    // Journey & user-directed
    'journey',
    'user-directed',
  ],
  // H1/H3 live only in regression — not duplicated in ui
  api: [
    'crud',
    'auth-matrix',
    'auth-bypass',
    'pagination',
    'boundary',
    'idempotency',
    'rate-limit',
    'idor-probe',
    // F2/F3 — Privilege escalation
    'horizontal-privilege',
    'vertical-privilege',
    // F5 — Mass assignment
    'mass-assignment',
  ],
  chaos: [
    'slow-network',
    'offline-mid-request',
    'offline-recovery',
    'back-during-post',
    'refresh-during-request',
    'double-submit',
    // C4 — Flaky network
    'flaky-network',
    // C5 — Request timeout + retry
    'timeout-retry',
    // C6 — WebSocket disconnect
    'websocket-disconnect',
  ],
  security: ['xss-probe'],  // F4 only — F1/F2/F3/F5 already run under api area
  accessibility: ['labels', 'keyboard', 'contrast'],
  performance: ['load-time', 'large-payload', 'spike-load', 'n-plus-one'],
  regression: ['golden-path', 'visual-regression', 'schema-drift'],
} as const;

export const FLOW_TITLES: Record<string, string> = {
  // UI
  'navigation': 'Navigation & Links',
  'form-validation': 'Form Validation',
  'input-boundary': 'Input Boundary',
  'double-click': 'Double Click',
  'modal-lifecycle': 'Modal Lifecycle',
  'empty-states': 'Empty States',
  'keyboard-nav': 'Keyboard Navigation',
  'viewport': 'Scroll & Viewport (A6)',
  'error-ui': 'Error UI & Toast Duration (A9)',
  'autofill': 'Copy/Paste & Autofill (A10)',
  'file-upload': 'File Upload Edge Cases (A11)',
  'pagination-ui': 'Pagination UI (A12)',
  'wizard': 'Multi-step Wizard (A13)',
  // Session
  'forward-after-back': 'Forward After Back (B2)',
  'deep-link': 'Deep Link Without Context (B5)',
  'session-timeout': 'Session Timeout Mid-Flow (B6)',
  'multi-tab-logout': 'Logout in Another Tab (B7)',
  // Journeys
  'journey': 'Domain Journey',
  'user-directed': 'User-Directed Flow',
  // API
  'crud': 'CRUD Endpoints',
  'auth-matrix': 'Auth Matrix',
  'auth-bypass': 'Auth Bypass',
  'pagination': 'API Pagination',
  'boundary': 'API Boundary',
  'idempotency': 'Idempotency',
  'rate-limit': 'Rate Limiting',
  'idor-probe': 'IDOR Probe',
  'horizontal-privilege': 'Horizontal Privilege Escalation (F2)',
  'vertical-privilege': 'Vertical Privilege Escalation (F3)',
  'mass-assignment': 'Mass Assignment (F5)',
  'n-plus-one': 'N+1 Query Pattern (G3)',
  'schema-drift': 'API Schema Drift (H2)',
  'spike-load': 'Spike Load (G1)',
  'load-time': 'Load Time',
  'large-payload': 'Large Payload',
  // Chaos
  'slow-network': 'Slow Network (3G)',
  'offline-mid-request': 'Offline During Submit',
  'offline-recovery': 'Offline Recovery',
  'back-during-post': 'Back During POST',
  'refresh-during-request': 'Refresh During Request',
  'double-submit': 'Double Submit',
  'flaky-network': 'Flaky Network 50% Drop (C4)',
  'timeout-retry': 'Request Timeout & Retry (C5)',
  'websocket-disconnect': 'WebSocket Disconnect (C6)',
  // Security
  'xss-probe': 'XSS Probe',
  // Accessibility
  'labels': 'Labels & ARIA',
  'keyboard': 'Keyboard Access',
  'contrast': 'Colour Contrast',
  // Regression
  'golden-path': 'Golden Path Snapshot (H1)',
  'visual-regression': 'Visual Regression (H3)',
};
