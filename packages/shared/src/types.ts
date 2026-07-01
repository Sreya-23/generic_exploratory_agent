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

export type AuthMethod = 'none' | 'password' | 'otp' | 'password-otp' | 'api-key' | 'bearer' | 'unknown';

export interface SessionCredentials {
  type: CredentialType;
  authMethod?: AuthMethod;
  username?: string;
  password?: string;
  otp?: string;
  apiKey?: string;
  bearerToken?: string;
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
  prdPath?: string;
  depth: SessionDepth;
  areas: ExplorationArea[];
  credentials?: SessionCredentials;
  openApiUrl?: string;
  /** User-provided exploration instructions e.g. "test the payment flow", "send link to +91..." */
  flowInstructions?: string[];
  /** Explicit list of flowClass strings to run (pinned from matrix IDs) */
  selectedFlowClasses?: string[];
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

export interface PreActionRequest {
  /** Category of the risky action */
  type: 'purchase' | 'payment' | 'send_link' | 'booking_confirm' | 'delete' | 'generic';
  description: string;
  /** Extra data keys the action requires (e.g. 'card', 'phone') */
  requiredExtras?: string[];
}

export interface ExecutorContext {
  sessionId: string;
  config: SessionConfig;
  sessionsDir: string;
  classification?: SiteClassification;
  onFinding: (finding: Omit<Finding, 'id' | 'sessionId' | 'createdAt'>) => void;
  onLog: (message: string) => void;
  onClassification?: (c: SiteClassification) => void;
  /**
   * Called before any risky / irreversible action (purchase, payment, send link, etc.).
   * Returns the extras data available (from credentials.extras) if the action can proceed,
   * or null if the required data is missing and the action should be skipped.
   * The orchestrator also emits a live chat message prompting the user to provide missing data.
   */
  onPreActionNeeded?: (req: PreActionRequest) => Record<string, string> | null;
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
