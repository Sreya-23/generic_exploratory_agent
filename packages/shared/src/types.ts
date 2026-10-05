export type ExplorationArea =
  | 'ui'
  | 'api'
  | 'chaos'
  | 'regression'
  | 'security'
  | 'accessibility'
  | 'performance';

export type SessionDepth = 'smoke' | 'standard' | 'deep' | 'chaos';

export type SessionStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'paused'
  | 'awaiting_auth'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type CredentialType = 'none' | 'login' | 'api-key' | 'bearer';

export type AuthMethod =
  | 'none'
  | 'password'
  | 'otp'           // phone/email → OTP code
  | 'password-otp'  // password + TOTP/OTP second factor
  | 'magic-link'    // email → click link in email
  | 'oauth'         // Google / Apple / Facebook / Microsoft SSO
  | 'saml'          // enterprise SSO / SAML redirect
  | 'api-key'
  | 'bearer'
  | 'unknown';

export interface SessionCredentials {
  type: CredentialType;
  authMethod?: AuthMethod;
  username?: string;
  password?: string;
  otp?: string;
  apiKey?: string;
  bearerToken?: string;
  /**
   * Raw cookie string (for OAuth/SAML where the user pastes cookies from DevTools).
   * Format: "name=value; name2=value2"
   */
  cookieString?: string;
  /**
   * Magic-link redirect URL — the user pastes the link from their email.
   */
  magicLinkUrl?: string;
  /** Any extra site-specific inputs: phone, card number, account ID, merchant ID, etc. */
  extras?: Record<string, string>;
}

export interface AuthProbeResult {
  targetUrl: string;
  title: string;
  requiresAuth: boolean;
  suggestedMethod: AuthMethod;
  hasPasswordField: boolean;
  hasOtpField: boolean;
  hasUsernameField: boolean;
  hasOAuthButton?: boolean;
  hasMagicLink?: boolean;
  hasSaml?: boolean;
  error?: string;
}

export type AuthState =
  | 'unknown'
  | 'not_required'
  | 'required'
  | 'awaiting_method'
  | 'awaiting_username'
  | 'awaiting_password'
  | 'awaiting_otp'
  | 'ready';

export interface SessionConfig {
  targetUrl: string;
  context?: string;
  depth: SessionDepth;
  areas: ExplorationArea[];
  credentials?: SessionCredentials;
  openApiUrl?: string;
  /** User-provided exploration instructions e.g. "test the payment flow", "send link to +91..." */
  flowInstructions?: string[];
  /** Explicit list of flowClass strings to run (pinned from matrix IDs) */
  selectedFlowClasses?: string[];
}

export interface FindingFingerprintDiff {
  previousSessionId?: string;
  newFindings: string[];
  fixedFindings: string[];
  recurringFindings: string[];
  markdown: string;
}

export interface Finding {
  id: string;
  sessionId: string;
  severity: Severity;
  area: string;
  title: string;
  preconditions?: string;
  steps: string[];
  expected: string;
  actual: string;
  evidence: string[];
  reproRate: string;
  automationCandidate: boolean;
  createdAt: string;
  /** FlowTask.id when finding came from a planned task */
  taskId?: string;
  /** Stable fingerprint for cross-session diff (area|normalized-title) */
  fingerprint?: string;
  /**
   * When set, this is a known demo/environment quirk — not a production-severity defect.
   * Severity is usually downgraded to info.
   */
  quarantineReason?: string;
  tags?: string[];
  /**
   * The page the finding was observed on, and a stable-ish identifier for the specific
   * element involved (id, data-testid/data-test, name attribute, or a tag+text+index
   * fallback — see elementFingerprint() in explorer-ui/flows/helpers.ts). When both are
   * present on two findings, the report's dedup treats a match as strong evidence they're
   * the SAME underlying defect (e.g. the same broken button hit by two different flows)
   * even when the finding titles are worded completely differently — a more precise
   * root-cause signal than title-text similarity alone.
   */
  pageUrl?: string;
  targetSelector?: string;
  /**
   * 'verified' — multiple independent signals agree (e.g. a DOM measurement AND a visual
   * check both flag the same area), or the signal is an objective, unambiguous browser fact
   * (naturalWidth===0, a thrown JS exception, an HTTP status code).
   * 'heuristic' — a single AI-vision read, or a single fuzzy/pattern-based signal with no
   * corroborating check. Not necessarily wrong, but should be spot-checked before treating as
   * confirmed. Omitted entirely for checks that predate this field — absence is not a claim
   * either way, just unclassified.
   */
  confidence?: 'verified' | 'heuristic';
  /** One sentence on why `confidence` was set this way — shown alongside the finding. */
  confidenceReason?: string;
}

/**
 * One UI-hidden-but-DOM-present link, and whether it's actually reachable when navigated to
 * directly — the ground truth behind hidden-route-access.ts's findings, recorded regardless of
 * outcome so the report can show a real access map (what's hidden vs. what's hidden-and-also-
 * enforced) rather than only the failures. Reflects the SINGLE currently-authenticated role —
 * this codebase logs in once per session (see performSessionLogin), so a true side-by-side
 * multi-role comparison (Admin vs. Manager vs. User) would need multiple real credential sets
 * and multiple real logins, which isn't how session auth is architected here and would add
 * real risk (extra OTP sends, lockout exposure) against a live account — out of scope for now.
 */
export interface AccessMapEntry {
  feature: string;
  pageUrl: string;
  visibleInUi: false;
  directlyReachable: boolean;
  note?: string;
}

/**
 * One (page, environment) pair that cross-browser.ts or device-matrix.ts actually checked,
 * recorded regardless of outcome — the ground truth a report needs to render a real ✓/✗
 * comparison grid, since findings alone only ever record the ✗ side.
 */
export interface EnvironmentCheck {
  pageUrl: string;
  /** e.g. "Chromium", "Firefox", "WebKit", or a device name like "iPhone 13" */
  environment: string;
  kind: 'browser' | 'device';
  ok: boolean;
  /** Short reason when ok is false — the finding title, or the load error. */
  note?: string;
}

export interface FlowTask {
  id: string;
  area: ExplorationArea;
  flowClass: string;
  title: string;
  description: string;
  priority: number;
}

export interface ExplorationPlan {
  sessionId: string;
  phases: PlanPhase[];
  tasks: FlowTask[];
  generatedAt: string;
}

export interface PlanPhase {
  id: string;
  name: string;
  description: string;
  taskIds: string[];
}

export interface SessionState {
  id: string;
  config: SessionConfig;
  status: SessionStatus;
  plan?: ExplorationPlan;
  findings: Finding[];
  progress: SessionProgress;
  authProbe?: AuthProbeResult;
  authState?: AuthState;
  classification?: SiteClassification;
  /**
   * Real API endpoints captured from the site's network traffic during
   * recon and authenticated BFS traversal. Persisted here so all tasks
   * (including API executor which runs later) can access them.
   */
  discoveredApiEndpoints?: string[];
  /** Every distinct button/icon-button/menu-item found and what happened when clicked. */
  actionInventory?: ActionInventorySummary;
  /**
   * Diff vs the most recent previous completed session for the same target — new / fixed /
   * recurring findings. Populated for every session once a prior run against the same
   * target exists.
   */
  findingDiff?: FindingFingerprintDiff;
  /**
   * URL reached after successful session login (e.g. /inventory.html).
   * Tasks should open this instead of the login URL so exploration runs inside the app.
   */
  postLoginUrl?: string;
  /** Distinct routes discovered from links on the landing page (set by recon). */
  discoveredRoutes?: string[];
  /** Distinct routes actually navigated to during the session — the "what did we really cover" answer. */
  visitedRoutes?: string[];
  /**
   * Every (page, environment) pair cross-browser.ts/device-matrix.ts actually checked, pass or
   * fail — unlike findings (which only ever record failures), this is what lets the report
   * build an honest comparison grid with real ✓ cells, not just blank-where-no-finding-exists.
   */
  environmentChecks?: EnvironmentCheck[];
  /** Every UI-hidden link checked for direct reachability this session — see AccessMapEntry. */
  accessMap?: AccessMapEntry[];
  /**
   * Persistent per-CATEGORY "what does this kind of application do" doc (see
   * site-knowledge-base.ts) — keyed by classification.siteType (fintech, ecommerce,
   * saas-dashboard, ...), not hostname: generated once the first time that category is seen,
   * reused silently for every other, different site that later classifies into the same
   * category. Markdown, human-readable, also saved to disk under
   * knowledge-base/<siteType>.md so it survives independently of any one session.
   */
  siteKnowledge?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SessionProgress {
  currentPhase?: string;
  currentTask?: string;
  completedTasks: number;
  totalTasks: number;
  percent: number;
}

export type SessionEventType =
  | 'session:created'
  | 'session:started'
  | 'session:sync'
  | 'session:progress'
  | 'session:finding'
  | 'session:completed'
  | 'session:failed'
  | 'session:paused'
  | 'task:started'
  | 'task:completed'
  | 'site:classified'
  | 'pre_action:required'
  | 'log'
  | 'chat:message'
  | 'chat:history'
  | 'auth:required'
  | 'auth:otp_required';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: string;
  payload: unknown;
}

export interface ReconResult {
  url: string;
  title: string;
  links: string[];
  forms: FormInfo[];
  apiCalls: string[];
  hasLoginWall: boolean;
}

export interface FormInfo {
  action: string;
  method: string;
  fields: string[];
}

/** Outcome observed after clicking a discovered action-inventory candidate. */
export type ActionInventoryResult =
  | 'navigation'
  | 'modal'
  | 'dom-change'
  | 'no-effect'
  | 'error'
  | 'skipped-risky'
  | 'skipped-disabled'
  | 'skipped-blocked'
  | 'no-effect-expected';

export interface ActionInventoryEntry {
  label: string;
  kind: 'button' | 'icon-button' | 'menu-item' | 'tab' | 'other';
  pageUrl: string;
  result: ActionInventoryResult;
  detail?: string;
  evidence?: string;
}

/**
 * Structured inventory of every distinct button/icon-button/menu-item/tab discovered
 * during exploration and what happened when each was clicked — the "explored every action,
 * not just every link" artifact, surfaced as its own report section.
 */
export interface ActionInventorySummary {
  totalFound: number;
  totalTested: number;
  totalSkippedRisky: number;
  byResult: Record<string, number>;
  entries: ActionInventoryEntry[];
}

export interface PreActionRequest {
  /** Category of the risky action */
  type: 'purchase' | 'payment' | 'send_link' | 'booking_confirm' | 'delete' | 'generic' | 'otp';
  description: string;
  /** Extra data keys the action requires (e.g. 'card', 'phone') */
  requiredExtras?: string[];
  /** URL the action was reached on, so the resulting "skipped" finding is locatable. */
  pageUrl?: string;
}

export interface ExecutorContext {
  sessionId: string;
  config: SessionConfig;
  sessionsDir: string;
  classification?: SiteClassification;
  /**
   * Real API endpoints discovered by the recon phase from network traffic.
   * Format: "METHOD /path" e.g. "GET /api/v2/menu", "POST /api/orders"
   * API executor uses these instead of generic guesses.
   */
  discoveredApiEndpoints?: string[];
  /** Authenticated landing URL from performSessionLogin — prefer over targetUrl for exploration. */
  postLoginUrl?: string;
  /** Accumulated across the session by action-inventory.ts; read by the reporter. */
  actionInventory?: ActionInventorySummary;
  /**
   * Set by the orchestrator once several consecutive tasks have failed with the same
   * page-load-timeout signature — a signal the target site itself is currently degraded, not
   * that the app has a bug. Executors use this to fail faster on subsequent tasks (shorter
   * timeout budget) instead of burning a full budget repeating the same failure.
   */
  envDegraded?: boolean;
  onFinding: (finding: Omit<Finding, 'id' | 'sessionId' | 'createdAt'>) => void;
  onLog: (message: string) => void;
  onClassification?: (c: SiteClassification) => void | Promise<void>;
  /**
   * Called before any risky / irreversible action (purchase, payment, send link, etc.).
   * Returns the extras data available (from credentials.extras) if the action can proceed,
   * or null if the required data is missing and the action should be skipped.
   * The orchestrator also emits a live chat message prompting the user to provide missing data.
   */
  onPreActionNeeded?: (req: PreActionRequest) => Record<string, string> | null;
  /** Distinct routes (origin+pathname) discovered from links on the landing page, set by recon. */
  discoveredRoutes?: string[];
  /** Distinct routes actually navigated to during the session, set by the coverage-report flow. */
  visitedRoutes?: string[];
  /**
   * Every (page, environment) pair cross-browser.ts/device-matrix.ts actually checked, pass or
   * fail. Flows append to whatever they received (producing a new array reference) rather than
   * overwriting — same "flow owns the merge, orchestrator just copies the reference across if
   * it changed" contract as discoveredRoutes/visitedRoutes above.
   */
  environmentChecks?: EnvironmentCheck[];
  /** Every UI-hidden link checked for direct reachability this session — see AccessMapEntry. */
  accessMap?: AccessMapEntry[];
}

export interface ExecutorResult {
  taskId: string;
  success: boolean;
  findingsCount: number;
  error?: string;
}

export interface BaseExecutor {
  name: string;
  areas: ExplorationArea[];
  execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult>;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  meta?: {
    findingId?: string;
    severity?: Severity;
    kind?: 'setup' | 'progress' | 'finding' | 'status' | 'command' | 'auth';
  };
}

export interface SetupDraft {
  targetUrl?: string;
  context?: string;
  depth: SessionDepth;
  areas: ExplorationArea[];
  credentials: SessionCredentials;
  needsLogin?: boolean;
  authProbe?: AuthProbeResult;
  authState?: AuthState;
  /** Whether the agent has asked "do you need credentials?" */
  credentialsAsked?: boolean;
  /** User-provided flow instructions */
  flowInstructions?: string[];
  /** Explicitly selected matrix flow IDs (e.g. "A6", "B2", "C4") mapped to flowClass strings */
  selectedFlowClasses?: string[];
}

export interface SetupChatResponse {
  conversationId: string;
  messages: ChatMessage[];
  draft: SetupDraft;
  readyToStart: boolean;
  missing: string[];
  config?: SessionConfig;
}

// ── Site Intelligence ─────────────────────────────────────────────────────────

export type SiteType =
  | 'ecommerce'
  | 'booking'
  | 'saas-dashboard'
  | 'auth-portal'
  | 'blog-cms'
  | 'social'
  | 'fintech'
  // A chat/copilot-style AI product (prompt input + generated response), not a traditional
  // CRUD-shaped app — correctness here means "did it respond/degrade gracefully," not "does
  // this exact text match," since the output is legitimately non-deterministic.
  | 'ai-product'
  | 'generic';

export interface SiteClassification {
  siteType: SiteType;
  confidence: number;
  signals: string[];
  inferredJourneys: string[];
  keyFeatures: string[];
}

export interface SiteIntelligenceSignals {
  title: string;
  metaDescription: string;
  headings: string[];
  linkTexts: string[];
  buttonTexts: string[];
  inputTypes: string[];
  urlPaths: string[];
  textSample: string;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface LiveChatResponse {
  messages: ChatMessage[];
  action?: 'pause' | 'status' | 'resume' | 'update_auth' | 'none';
  credentials?: SessionCredentials;
  authState?: AuthState;
}
