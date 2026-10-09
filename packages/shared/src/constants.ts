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
    description: 'Full generic exploration baseline (~1-2 hrs)',
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
    // Native <select> dropdowns — first/last/multi selection, keyboard arrow navigation.
    'dropdown-exploration',
    // Popups (target="_blank"/window.open) and browser-permission-denial handling.
    'browser-behavior',
    // Hover/active visual-state feedback on interactive elements.
    'interactive-states',
    // Field-type-specific validation: email format, numeric/date bounds, confirm-password.
    'field-validation',
    // Table/list row selection, select-all, expand/collapse, duplicate-row detection.
    'table-interaction',
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
    // Generic, site-type-agnostic logout check: click a real logout control, then Back/Refresh/
    // direct-URL in the SAME tab — distinct from the auth-portal-journey-gated logout test,
    // from B6's cookie-clearing (a different trigger), and from B7's second-tab check.
    'logout-session',
    // "Forgot password" link reachability (not the full reset flow — that needs real email access).
    'forgot-password',
    // Session cleared mid-request (not pre-expired like B6) — checks for a clear re-auth prompt.
    'session-expires-mid-op',
    // Journey & user-directed
    'journey',
    'user-directed',
    // Element integrity — occlusion, disabled-state mismatch, zero-size/off-screen, touch targets
    'element-integrity',
    'touch-target',
    // Dead internal links
    'dead-links',
    // Action inventory — every button/icon-button/menu-item/tab found and what clicking it did
    'action-inventory',
    // Correlates a save/create/update action's REAL network response against what the UI
    // actually tells the user happened — catches "shows success but the backend request
    // failed" and its inverse, a class of bug no DOM-only or API-only check can see.
    'data-integrity',
    // Canceling an edit must discard the change — verified by reload, not just re-reading
    // the live form. The one state-transition pattern with zero ambiguity about correctness.
    'state-transition',
    // A link present in the DOM but hidden/disabled from view (client-side conditional
    // render) whose href is still directly reachable and renders real content — a common
    // authorization gap where the UI hides an action but nothing enforces it server-side.
    // UI-level (needs a live Playwright page), unlike auth-matrix/auth-bypass which are
    // pure-HTTP checks owned by ApiExecutor — this stays in the 'ui' area for that reason.
    'hidden-route-access',
    // Generic, domain-agnostic CRUD lifecycle (create → verify → edit → verify → delete →
    // verify) on any detected create-shaped form/list — distinct from journey.ts's per-site-
    // type CRUD flows, which only fire for one classified domain.
    'generic-crud',
    // Cancel-creation, cancel-deletion (confirmation dialog), and duplicate-creation —
    // separate tasks from the main CRUD lifecycle since each needs its own fresh page visit.
    'cancel-creation',
    'cancel-deletion',
    'duplicate-creation',
    // Cross-browser compatibility spot-check (Firefox/WebKit vs the Chromium baseline)
    'cross-browser',
    // Consent & user agreement exploration (T&C, privacy, marketing, cookie, age, etc.)
    'consent-exploration',
    // I1/I2 — Business-logic boundary testing on amount/price/quantity-like fields
    'business-logic-boundary',
    // Real device emulation — phones/tablets across iOS (WebKit) and Android (Chromium)
    // engines, distinct from viewport.ts (same engine, just resized) and cross-browser.ts
    // (desktop-sized engine comparison only)
    'device-matrix',
    // AI-powered visual QA (vision-capable LLM — Gemini/OpenAI/Anthropic, see llm-client.ts)
    // — catches rendering defects with no DOM/CSS signal at all (overlap, clipping,
    // off-screen elements, leftover placeholder copy). Purely additive: skips gracefully if
    // no LLM API key is configured or the API call fails, never affecting any other flow.
    'visual-review',
    // Live, per-step AI-driven exploration — a model decides the next action by looking at
    // the actual current page, instead of running a pre-written script. Additive and bounded:
    // skips gracefully if no LLM API key is configured, runs at standard/deep depth only,
    // capped at a handful of actions per run.
    'agentic-explore',
    // WCAG 1.4.10 — layout must reflow without 2D scrolling at up to 400% browser zoom
    'zoom-reflow',
    // prefers-color-scheme: dark support and base contrast under it
    'dark-mode',
    // prefers-reduced-motion — animations should pause/reduce when requested
    'reduced-motion',
    // Keyboard focus should stay trapped inside an open modal dialog
    'focus-trap',
    // Custom field icons that may collide with a real browser's native autofill icon
    'autofill-overlap',
    // Extremely long, unbroken input values shouldn't break surrounding layout
    'long-content',
    // Browser back/forward-cache restore should be immediately interactive
    'bfcache',
    // Clicking a download control should yield a valid, non-empty file
    'download-verify',
    // Multiple toasts/notifications fired in quick succession shouldn't overlap
    'toast-stacking',
    // Hardcoded LTR layout assumptions surfaced by forcing dir="rtl"
    'rtl-layout',
    // Placeholder text leaking into the real submitted value, or left as dev/lorem-ipsum copy
    'placeholder-check',
    // <img> elements that fail to decode, and CSS background-images that 404
    'broken-images',
    // Text clipped/overflowing its OWN box — not just whole-page horizontal scroll
    'element-overflow',
    // Uncaught JS exceptions and console.error calls, accumulated across the whole session
    'js-errors',
    // Discovered routes (recon) vs actually-visited routes (whole session) — the explicit,
    // checkable answer to "was everything actually explored"
    'coverage-report',
    // Core Web Vitals (LCP/CLS/INP) — user-perceived rendering performance, distinct from the
    // network/server-focused checks under the performance area
    'web-vitals',
    // Mid-form draft loss on navigate-away-and-back, and passive same-record multi-tab
    // edit-awareness
    'concurrent-edit',
    // Text-expansion layout tolerance and locale-aware date/currency formatting under a
    // non-default browser locale — distinct from rtl-layout.ts (direction, not locale)
    'locale-format',
    // Service worker registration + real offline-cache behavior (genuine network cutoff, not
    // per-request interception like chaos/flaky-network.ts)
    'offline-pwa',
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
    // Sensitive-data-exposure scan, per-user-endpoint cache-control check, and a request-
    // tracing-header observability note — all passive, read-only inspection of responses
    // already being fetched for other checks.
    'response-hygiene',
    // OPTIONS + bodyless POST against confirmed GET endpoints — never PUT/PATCH/DELETE, no
    // residual mutation risk.
    'http-method-validation',
    // Request validation, data-type coercion, boundary values, and SQL/NoSQL/path-traversal
    // payloads — all variations of "send a malformed write request, check the server
    // degrades cleanly instead of crashing."
    'malformed-input',
    // Functional correctness of pagination/search, distinct from boundary.ts's testPagination
    // (which only checks invalid params don't crash). Does page 2 actually differ from page 1,
    // and does a declared total/count match what's actually returned — all GET, zero risk.
    'functional-listing',
    // Full create→get→update→get→delete→get chain on one self-created synthetic resource —
    // status-code validation and data-consistency, not just "did the write call 2xx."
    'crud-lifecycle',
    // True-concurrency (Promise.all, not sequential) race-condition probes: does an
    // Idempotency-Key actually dedupe under simultaneous requests, and do concurrent updates
    // ever corrupt a resource rather than just "last write wins."
    'concurrency',
    // Raw multipart upload-endpoint probing (oversized file, path-traversal filename, dangerous
    // extension) — only runs against an endpoint whose path looks upload-shaped.
    'file-payload',
    // Conditional: only activates if a 202 Accepted response is actually observed. Verifies the
    // 202 contract itself (a trackable job reference) and that polling resolves in a bounded
    // window — no generic webhook/callback testing is possible without site-specific knowledge.
    'async-operations',
    // Invalid/malformed/expired-shaped bearer tokens + JWT alg:none bypass attempt — distinct
    // from auth-matrix, which only tests the "no token at all" case.
    'token-validation',
    // Conditional: only activates if a refresh-shaped endpoint is actually discovered.
    'token-refresh',
    // Error response shape consistency across endpoints + stack-trace-in-error-body leak check.
    'error-consistency',
    // Non-existent resource id should return 404, not 200/500 — a narrow, zero-risk GET-only
    // status-code contract check, distinct from boundary.ts's invalid-pagination-param checks.
    'status-code-validation',
    // Two sequential (not simultaneous — that's concurrency) rapid writes to the same
    // self-created resource: does the later request actually win, or does a slower-but-earlier
    // one clobber it on arrival.
    'request-ordering',
    // Conditional: only activates if the self-created resource exposes a recognizable
    // status/state field. Checks for unconditional terminal-state jumps and crash-on-repeat.
    'state-transition-api',
  ],
  chaos: [
    'slow-network',
    'offline-mid-request',
    'offline-recovery',
    'back-during-post',
    'refresh-during-request',
    // Cancel/navigate-away while a request is in flight — observational, same posture as
    // back-during-post/refresh-during-request above.
    'cancel-during-loading',
    'navigate-away-during-loading',
    'double-submit',
    // C4 — Flaky network
    'flaky-network',
    // C5 — Request timeout + retry
    'timeout-retry',
    // C6 — WebSocket disconnect
    'websocket-disconnect',
    // Low-end-device CPU throttling — distinct from slow-network above
    'cpu-throttle',
  ],
  security: ['xss-probe', 'security-headers'],  // F4, F6/F7/F8 — F1/F2/F3/F5 already run under api area
  accessibility: ['labels', 'keyboard', 'contrast', 'semantic-structure'],
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
  'dropdown-exploration': 'Dropdown & Select Exploration',
  'browser-behavior': 'Browser Behaviour (popups, permissions)',
  'interactive-states': 'Interactive Visual States (hover, active)',
  'field-validation': 'Field-Type Validation (email, numeric, date, confirm-password)',
  'table-interaction': 'Table/List Interaction (selection, expand/collapse, duplicates)',
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
  'logout-session': 'Logout: Back/Refresh/Direct-URL (same tab)',
  'forgot-password': 'Forgot Password Link Reachability',
  'session-expires-mid-op': 'Session Expires Mid-Operation',
  // Journeys
  'journey': 'Domain Journey',
  'user-directed': 'User-Directed Flow',
  // Element integrity
  'element-integrity': 'Element Integrity (occlusion, disabled-state)',
  'touch-target': 'Touch Target Size (mobile)',
  'dead-links': 'Dead Internal Links',
  'action-inventory': 'Action Inventory',
  'data-integrity': 'Data Integrity (UI vs backend truth)',
  'state-transition': 'State Transition (cancel discards changes)',
  'hidden-route-access': 'Hidden Route Access (UI hidden, URL reachable)',
  'generic-crud': 'Generic CRUD Lifecycle (create/edit/delete)',
  'cancel-creation': 'Cancel Creation (no entity should persist)',
  'cancel-deletion': 'Cancel Deletion (confirmation dialog)',
  'duplicate-creation': 'Duplicate Creation Observation',
  'cross-browser': 'Cross-Browser Compatibility',
  'consent-exploration': 'Consent & User Agreement Exploration',
  'business-logic-boundary': 'Business Logic Boundary (amount/price/quantity) (I1/I2)',
  'device-matrix': 'Real Device Matrix (iPhone/iPad/Pixel/Galaxy Tab)',
  'visual-review': 'AI Visual QA Review (Gemini vision, optional)',
  'agentic-explore': 'AI Agentic Exploration (Gemini, optional)',
  'zoom-reflow': 'Zoom & Reflow (WCAG 1.4.10)',
  'dark-mode': 'Dark Mode (prefers-color-scheme)',
  'reduced-motion': 'Reduced Motion (prefers-reduced-motion)',
  'focus-trap': 'Modal Focus Trap',
  'autofill-overlap': 'Autofill Icon Overlap',
  'long-content': 'Long/Unbroken Content Stress Test',
  'bfcache': 'Back/Forward Cache Restore',
  'download-verify': 'Download Verification',
  'toast-stacking': 'Toast/Notification Stacking',
  'rtl-layout': 'RTL Layout',
  'placeholder-check': 'Placeholder Text Integrity',
  'broken-images': 'Broken Images',
  'element-overflow': 'Element-Level Text Overflow/Clipping',
  'js-errors': 'JavaScript Console Errors',
  'coverage-report': 'Page/Route Coverage Report',
  'web-vitals': 'Core Web Vitals (LCP/CLS/INP)',
  'concurrent-edit': 'Form Autosave & Concurrent Edit',
  'locale-format': 'Locale & Formatting',
  'offline-pwa': 'Service Worker & Offline',
  // API
  'crud': 'CRUD Endpoints',
  'auth-matrix': 'Auth Matrix',
  'auth-bypass': 'Auth Bypass',
  'pagination': 'API Pagination',
  'boundary': 'API Boundary',
  'idempotency': 'Idempotency',
  'response-hygiene': 'Response Hygiene (sensitive data, caching, tracing)',
  'http-method-validation': 'HTTP Method Validation',
  'malformed-input': 'Malformed Input (validation, data-type, boundary, injection)',
  'functional-listing': 'Functional Pagination & Search Correctness',
  'crud-lifecycle': 'CRUD Lifecycle & Data Consistency',
  'concurrency': 'Concurrency & Race Conditions',
  'file-payload': 'File Upload Endpoint Probing (size, path-traversal, extension)',
  'async-operations': 'Async/Background Job Operations (202 contract, polling)',
  'token-validation': 'Token Validation (invalid/malformed/expired/alg-none)',
  'token-refresh': 'Token Refresh Race',
  'error-consistency': 'Error Response Consistency',
  'status-code-validation': 'Status Code Validation (non-existent resource)',
  'request-ordering': 'Request Ordering (stale write wins)',
  'state-transition-api': 'State Transition (API)',
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
  'cpu-throttle': 'CPU Throttling (low-end device)',
  'slow-network': 'Slow Network (3G)',
  'offline-mid-request': 'Offline During Submit',
  'offline-recovery': 'Offline Recovery',
  'back-during-post': 'Back During POST',
  'refresh-during-request': 'Refresh During Request',
  'cancel-during-loading': 'Cancel During Loading',
  'navigate-away-during-loading': 'Navigate Away During Loading',
  'double-submit': 'Double Submit',
  'flaky-network': 'Flaky Network 50% Drop (C4)',
  'timeout-retry': 'Request Timeout & Retry (C5)',
  'websocket-disconnect': 'WebSocket Disconnect (C6)',
  // Security
  'xss-probe': 'XSS Probe',
  'security-headers': 'Security Headers, Cookie Flags & Clickjacking (F6/F7/F8)',
  // Accessibility
  'labels': 'Labels & ARIA',
  'semantic-structure': 'Semantic Structure (headings, button/link semantics)',
  'keyboard': 'Keyboard Access',
  'contrast': 'Colour Contrast',
  // Regression
  'golden-path': 'Golden Path Snapshot (H1)',
  'visual-regression': 'Visual Regression (H3)',
};
