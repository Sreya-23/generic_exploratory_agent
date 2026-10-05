import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ExplorationArea,
  SessionConfig,
  SessionCredentials,
  SessionDepth,
  SetupChatResponse,
  SetupDraft,
} from '@qa/shared';
import {
  applyAuthProbe,
  authPromptForState,
  authPromptFromProbe,
  clearAuthField,
  credentialsComplete,
  detectAuthCorrection,
  effectiveAuthState,
  mergeCredentials,
  nextAuthState,
  parseAuthFields,
} from './auth-chat.js';

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Exploration matrix ID → flowClass mapping */
export const MATRIX_ID_MAP: Record<string, string> = {
  // UI & Interaction
  A1: 'navigation',
  A2: 'form-validation',
  A3: 'input-boundary',
  A4: 'double-click',
  A5: 'keyboard-nav',
  A6: 'viewport',
  A7: 'modal-lifecycle',
  A8: 'empty-states',
  A9: 'error-ui',
  A10: 'autofill',
  A11: 'file-upload',
  A12: 'pagination-ui',
  A13: 'wizard',
  // Navigation & Session
  B1: 'back-during-post',
  B2: 'forward-after-back',
  B3: 'refresh-during-request',
  B5: 'deep-link',
  B6: 'session-timeout',
  B7: 'multi-tab-logout',
  // Network & Chaos
  C1: 'slow-network',
  C2: 'offline-mid-request',
  C3: 'offline-recovery',
  C4: 'flaky-network',
  C5: 'timeout-retry',
  C6: 'websocket-disconnect',
  // API
  D1: 'crud',
  D2: 'auth-matrix',
  D3: 'idempotency',
  D4: 'pagination',
  D7: 'rate-limit',
  // Security
  F1: 'idor-probe',
  F2: 'horizontal-privilege',
  F3: 'vertical-privilege',
  F4: 'xss-probe',
  F5: 'mass-assignment',
  // Performance
  G1: 'spike-load',
  G2: 'large-payload',
  G3: 'n-plus-one',
  // Regression
  H1: 'golden-path',
  H2: 'schema-drift',
  H3: 'visual-regression',
};

/** Parse matrix IDs like "A6, B2, F2" or "run A6 and B7" from user text */
function extractMatrixIds(text: string): string[] {
  const ids = [...text.matchAll(/\b([A-H]\d{1,2})\b/g)].map((m) => m[1].toUpperCase());
  return ids.filter((id) => id in MATRIX_ID_MAP);
}

/** Returns a formatted list of all matrix tests for display */
export function matrixTestList(): string {
  const sections: Record<string, { id: string; label: string }[]> = {
    'UI & Interaction': [
      { id: 'A1', label: 'Happy path navigation' },
      { id: 'A2', label: 'Form validation' },
      { id: 'A3', label: 'Input boundary' },
      { id: 'A4', label: 'Double / rapid actions' },
      { id: 'A5', label: 'Keyboard navigation' },
      { id: 'A6', label: 'Scroll & viewport' },
      { id: 'A7', label: 'Modal lifecycle' },
      { id: 'A8', label: 'Empty & loading states' },
      { id: 'A9', label: 'Error UI & toast duration' },
      { id: 'A10', label: 'Copy/paste & autofill' },
      { id: 'A11', label: 'File upload edge cases' },
      { id: 'A12', label: 'Pagination UI' },
      { id: 'A13', label: 'Multi-step wizard' },
    ],
    'Navigation & Session': [
      { id: 'B1', label: 'Back during API call' },
      { id: 'B2', label: 'Forward after back (stale form)' },
      { id: 'B3', label: 'Refresh during request' },
      { id: 'B5', label: 'Deep link without context' },
      { id: 'B6', label: 'Session timeout mid-flow' },
      { id: 'B7', label: 'Logout in another tab' },
    ],
    'Network & Chaos': [
      { id: 'C1', label: 'Slow network (3G)' },
      { id: 'C2', label: 'Offline mid-request' },
      { id: 'C3', label: 'Offline → online recovery' },
      { id: 'C4', label: 'Flaky network 50% drop' },
      { id: 'C5', label: 'Request timeout + retry' },
      { id: 'C6', label: 'WebSocket disconnect' },
    ],
    'API': [
      { id: 'D1', label: 'CRUD completeness' },
      { id: 'D2', label: 'Auth matrix' },
      { id: 'D3', label: 'Idempotency' },
      { id: 'D4', label: 'Pagination edge cases' },
      { id: 'D7', label: 'Rate limiting' },
    ],
    'Security': [
      { id: 'F1', label: 'IDOR probe' },
      { id: 'F2', label: 'Horizontal privilege escalation' },
      { id: 'F3', label: 'Vertical privilege escalation' },
      { id: 'F4', label: 'XSS in inputs' },
      { id: 'F5', label: 'Mass assignment' },
    ],
    'Performance': [
      { id: 'G1', label: 'Spike load' },
      { id: 'G2', label: 'Large payload' },
      { id: 'G3', label: 'N+1 UI pattern' },
    ],
    'Regression': [
      { id: 'H1', label: 'Golden path snapshot' },
      { id: 'H2', label: 'API schema drift' },
      { id: 'H3', label: 'Visual regression' },
    ],
  };

  return Object.entries(sections)
    .map(([section, tests]) => {
      const rows = tests.map((t) => `  \`${t.id}\` ${t.label}`).join('\n');
      return `**${section}**\n${rows}`;
    })
    .join('\n\n');
}

const AREA_KEYWORDS: Record<ExplorationArea, string[]> = {
  ui: ['ui', 'interface', 'forms', 'navigation', 'click', 'button', 'frontend', 'visual'],
  api: ['api', 'endpoint', 'rest', 'graphql', 'backend', 'request'],
  chaos: ['chaos', 'network', 'offline', 'resilience', 'interrupt', 'back button', 'failure'],
  regression: ['regression', 'baseline', 'compare', 'snapshot'],
  security: ['security', 'idor', 'auth', 'xss', 'privilege', 'vulnerability'],
  accessibility: ['accessibility', 'a11y', 'screen reader', 'keyboard', 'wcag'],
  performance: ['performance', 'load', 'stress', 'slow', 'speed', 'latency'],
};

const DEPTH_KEYWORDS: Record<SessionDepth, string[]> = {
  smoke: ['smoke', 'quick', 'fast', 'brief', 'sanity'],
  standard: ['standard', 'normal', 'regular', 'moderate'],
  deep: ['deep', 'thorough', 'comprehensive', 'full', 'exhaustive'],
  chaos: ['chaos focus', 'chaos only', 'resilience focus'],
};

// Keywords that signal a user-directed flow instruction
const FLOW_INSTRUCTION_PREFIXES = [
  'test', 'try', 'check', 'explore', 'focus on', 'verify', 'run',
  'simulate', 'go through', 'walk through', 'follow',
];

export interface SetupConversation {
  id: string;
  messages: ChatMessage[];
  draft: SetupDraft;
  createdAt: string;
}

function msg(role: ChatMessage['role'], content: string, meta?: ChatMessage['meta']): ChatMessage {
  return { id: randomUUID(), role, content, timestamp: new Date().toISOString(), meta };
}

function extractUrl(text: string): string | undefined {
  const match = text.match(URL_RE);
  if (!match) return undefined;
  return match[0].replace(/[.,;:!?)]+$/, '');
}

function extractAreas(text: string): ExplorationArea[] {
  const lower = text.toLowerCase();
  const found = new Set<ExplorationArea>();
  for (const [area, keywords] of Object.entries(AREA_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) {
      found.add(area as ExplorationArea);
    }
  }
  if (lower.includes('everything') || lower.includes('all areas')) {
    return ['ui', 'api', 'chaos', 'security', 'accessibility', 'performance'];
  }
  return Array.from(found);
}

function extractDepth(text: string): SessionDepth | undefined {
  const lower = text.toLowerCase();
  for (const [depth, keywords] of Object.entries(DEPTH_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return depth as SessionDepth;
  }
  return undefined;
}

function isStartCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^(start|go|begin|run|launch|yes|proceed|explore)$/i.test(t)) return true;
  if (/\b(start now|let's go|start exploration)\b/i.test(t)) return true;
  if (/\.\s*start\s*[.!]?\s*$/i.test(text)) return true;
  return /^(start|go|begin|run|launch)\b/i.test(t);
}

function isNoCredentials(text: string): boolean {
  return /^(no|none|nope|skip|not needed|no credentials?|no login|public|without login|don't need|dont need)\b/i.test(
    text.trim(),
  );
}

function isYesCredentials(text: string): boolean {
  return /^(yes|yeah|yep|yup|sure|i have|there are|it needs|requires)\b/i.test(text.trim());
}

/**
 * Detect a user-directed flow instruction like:
 * "test the payment flow", "try sending a link to +91...", "explore checkout as guest"
 */
function extractFlowInstruction(text: string): string | null {
  const lower = text.toLowerCase().trim();
  const hasPrefix = FLOW_INSTRUCTION_PREFIXES.some((p) => lower.startsWith(p));
  // Also capture: "the payment flow", "refund path", "send link to..."
  const hasFlowKeyword = /\bflow\b|\bpath\b|\bjourney\b|\bsend\b|\bpay\b|\bbook\b|\bcheckout\b|\bregister\b|\bsignup\b|\bonboard\b/.test(lower);

  if ((hasPrefix || hasFlowKeyword) && text.length > 8 && !extractUrl(text)) {
    return text.trim();
  }
  return null;
}

/**
 * Parse any extra label:value pairs not covered by standard auth fields.
 * e.g. "phone: +91 9876543210", "card: 4111111111111111", "account: ACC123"
 */
function extractExtras(text: string, existingExtras?: Record<string, string>): Record<string, string> | null {
  // Don't parse extras if the message is (or contains) a URL
  if (/https?:\/\//i.test(text)) return null;

  const extras: Record<string, string> = { ...(existingExtras ?? {}) };
  const KNOWN_KEYS = /^(email|user(?:name)?|users?names?|pass(?:word)?|pwd|otp|code|api[- ]?key|bearer|login|account)$/i;

  // Match "key: value" or "key = value" patterns — key must be a single word (no spaces)
  const matches = [...text.matchAll(/\b([a-zA-Z][a-zA-Z0-9_-]{1,29})\s*[:=]\s*([^\s,][^,\n]*?)(?=\s*[,\n]|$)/g)];
  let added = false;

  for (const m of matches) {
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (KNOWN_KEYS.test(key) || !value || key.length < 2) continue;
    extras[key] = value;
    added = true;
  }

  return added ? extras : null;
}

function missingFields(draft: SetupDraft): string[] {
  const missing: string[] = [];
  if (!draft.targetUrl) missing.push('target URL');
  if ((draft.authProbe?.requiresAuth || draft.needsLogin) && !credentialsComplete(draft)) {
    missing.push('authentication');
  }
  return missing;
}

function draftToConfig(draft: SetupDraft): SessionConfig | undefined {
  if (!draft.targetUrl || !credentialsComplete(draft)) return undefined;
  return {
    targetUrl: draft.targetUrl,
    context: draft.context,
    depth: draft.depth,
    areas: draft.areas.length ? draft.areas : ['ui'],
    credentials: draft.credentials,
    flowInstructions: draft.flowInstructions?.length ? draft.flowInstructions : undefined,
    selectedFlowClasses: draft.selectedFlowClasses?.length ? draft.selectedFlowClasses : undefined,
  };
}

function summarizeDraft(draft: SetupDraft): string {
  const areas = draft.areas.length ? draft.areas.join(', ') : 'ui (default)';
  let creds = 'Public (no login)';

  if (draft.credentials.type === 'login') {
    const m = draft.credentials.authMethod ?? 'password';
    creds = `Login (${m}) as ${draft.credentials.username ?? '?'}`;
  } else if (draft.credentials.type === 'api-key') {
    creds = 'API key';
  } else if (draft.credentials.type === 'bearer') {
    creds = 'Bearer token';
  }

  const extrasLine =
    draft.credentials.extras && Object.keys(draft.credentials.extras).length > 0
      ? `**Extra inputs:** ${Object.entries(draft.credentials.extras)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}`
      : '';

  const instructionsLine =
    draft.flowInstructions?.length
      ? `**Flow instructions:**\n${draft.flowInstructions.map((i) => `  - ${i}`).join('\n')}`
      : '';

  // Show selected matrix tests (reverse-map flowClass → matrix ID for display)
  const reverseMap = Object.fromEntries(
    Object.entries(MATRIX_ID_MAP).map(([id, fc]) => [fc, id]),
  );
  const selectedLine =
    draft.selectedFlowClasses?.length
      ? `**Selected tests:** ${draft.selectedFlowClasses.map((fc) => reverseMap[fc] ?? fc).join(', ')}`
      : '';

  return [
    `**Target:** ${draft.targetUrl ?? '(not set)'}`,
    `**Depth:** ${draft.depth}`,
    `**Areas:** ${areas}`,
    `**Auth:** ${creds}`,
    extrasLine,
    instructionsLine,
    selectedLine,
    draft.context ? `**Context:** ${draft.context.slice(0, 120)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAssistantReply(
  draft: SetupDraft,
  userText: string,
  justCaptured?: Partial<SessionCredentials>,
): string {
  const missing = missingFields(draft);
  const authState = effectiveAuthState(draft);

  if (isStartCommand(userText) && !isYesCredentials(userText)) {
    if (missing.length > 0) {
      const authPrompt = authPromptForState(draft);
      if (missing.includes('authentication') && authPrompt) return authPrompt;
      return `I still need: **${missing.join(', ')}** before we can start.\n\n${summarizeDraft(draft)}`;
    }
    return `Starting exploration.\n\n${summarizeDraft(draft)}`;
  }

  if (!draft.targetUrl) {
    return `What's the **website URL** to explore?\n\nExample: \`https://staging.myapp.com\``;
  }

  // After URL is set but before we've asked about credentials
  if (draft.targetUrl && !draft.credentialsAsked && !draft.needsLogin && !draft.authProbe) {
    return (
      `Got it — **${draft.targetUrl}**\n\n` +
      `Does this site need any credentials to log in?\n\n` +
      `- **Login**: \`username: admin\` / \`password: secret\`\n` +
      `- **OTP login**: \`username: <phone or email>\` — I'll trigger the real code myself and ask you for it once the site actually sends it (don't type a code now, it wouldn't be real yet)\n` +
      `- **API key**: \`api-key: sk-abc123\`\n` +
      `- **Extra inputs** (phone, card, account ID): \`phone: +91 9876543210\`\n` +
      `- Reply **"no"** if the site is publicly accessible\n\n` +
      `Tip: For risky actions like payments or purchases, I'll ask for card/phone details when needed.`
    );
  }

  // Acknowledge extras saved
  if (justCaptured?.extras) {
    const keys = Object.keys(justCaptured.extras).join(', ');
    return (
      `✅ Saved extra inputs: **${keys}**\n\n` +
      `Anything else? Or say **"start"** to begin.\n\n${summarizeDraft(draft)}`
    );
  }

  // Acknowledge captured auth field and ask for next one
  if (justCaptured?.username && authState === 'awaiting_password') {
    return `✅ Username saved.\n\n${authPromptForState(draft)}`;
  }
  if (justCaptured?.password && authState === 'awaiting_otp') {
    // Don't invite an OTP here — no real code has been sent yet (that only happens once
    // exploration actually starts and visits the site). Asking for one now just invites
    // the same stale/guessed-code bug this flow used to have.
    return (
      `✅ Password saved.\n\n` +
      `I'll trigger the real OTP send once we start, and ask you for the code in chat then.\n\n` +
      `Say **"start"** when ready.`
    );
  }
  if (justCaptured?.otp && credentialsComplete(draft)) {
    return (
      `Noted — but heads up: I can't use an OTP given now, since the real code only exists ` +
      `after I've actually triggered a send (which happens once exploration starts). ` +
      `I'll ask you for it again in chat right after that happens.\n\n` +
      `Say **"start"** when ready.`
    );
  }

  if (!credentialsComplete(draft) && authState !== 'ready') {
    const prompt = authPromptForState(draft);
    if (prompt) {
      return (
        `${prompt}\n\n` +
        `_Tip: Mistyped something? Say **"change username"** or **"change password"**, or resend \`username: ...\`._`
      );
    }
  }

  if (missing.length === 0) {
    const startHint =
      draft.credentials.type !== 'none'
        ? `I'll log in with the provided credentials, then run a full exploration.`
        : `I'll run a full exploration of the site.`;
    return (
      `✅ All set!\n\n${startHint}\n\n` +
      `${summarizeDraft(draft)}\n\n` +
      `I'll automatically run UI flows, API probes, chaos tests, security checks, and regression snapshots. ` +
      `Before any risky action (payment, purchase, sending a link) I'll check with you first.\n\n` +
      `Say **"start"** or click **Start Exploration** to begin.`
    );
  }

  return `Got it.\n\n${summarizeDraft(draft)}`;
}

export function createSetupConversation(): SetupConversation {
  const id = randomUUID();
  const welcome = msg(
    'assistant',
    [
      `Hi! I'm your exploratory QA assistant.`,
      ``,
      `Paste the **website URL** to start. I'll automatically:`,
      `- Detect login requirements and ask for credentials if needed`,
      `- Identify the site type and run domain-appropriate journeys`,
      `- Run all applicable tests — UI, API, chaos, security, regression, performance`,
      ``,
      `Before any risky action (purchase, payment, sending a link) I'll pause and check with you first.`,
      ``,
      `Example: \`https://staging.myapp.com\``,
    ].join('\n'),
    { kind: 'setup' },
  );

  return {
    id,
    messages: [welcome],
    draft: {
      depth: 'standard',
      areas: ['ui', 'api', 'chaos', 'security', 'performance', 'regression'],
      credentials: { type: 'none', authMethod: 'none' },
      authState: 'unknown',
      credentialsAsked: false,
      flowInstructions: [],
    },
    createdAt: new Date().toISOString(),
  };
}

export function processSetupMessage(
  conversation: SetupConversation,
  userText: string,
): SetupChatResponse {
  const text = userText.trim();
  conversation.messages.push(msg('user', text));

  const url = extractUrl(text);
  if (url) conversation.draft.targetUrl = url;

  const areas = extractAreas(text);
  if (areas.length > 0) {
    conversation.draft.areas = [...new Set([...conversation.draft.areas, ...areas])];
  }

  const depth = extractDepth(text);
  if (depth) conversation.draft.depth = depth;

  // Mark credentials as asked when we have a URL (the reply will ask the question)
  if (conversation.draft.targetUrl && !conversation.draft.credentialsAsked && !url) {
    conversation.draft.credentialsAsked = true;
  }

  // Handle explicit "no credentials" reply — this must work even when needsLogin is already
  // true (the probe detected/guessed the site requires auth), not just when it's false.
  // Confirmed real gap: the old `&& !conversation.draft.needsLogin` guard disabled this
  // EXACTLY when it mattered — needsLogin only becomes true once the probe has already
  // decided auth is required and started asking for credentials, which is precisely the
  // moment a user needs to say "skip login, explore anonymously" to override that guess
  // (e.g. an e-commerce catalog where almost everything is browsable without an account,
  // even if some page the probe happened to check was gated). The explicit "no" always wins.
  if (isNoCredentials(text)) {
    conversation.draft.credentials = { type: 'none', authMethod: 'none' };
    conversation.draft.needsLogin = false;
    conversation.draft.authState = 'ready';
  }

  // Handle "yes, I have credentials" — default to password auth so the flow goes
  // URL → username → password (user can correct the method inline if needed)
  if (isYesCredentials(text) && !conversation.draft.needsLogin && !url) {
    conversation.draft.needsLogin = true;
    conversation.draft.credentials = {
      ...conversation.draft.credentials,
      type: 'login',
      authMethod: 'password',
    };
    conversation.draft.authState = nextAuthState(conversation.draft);
  }

  // User wants to re-enter a mistaken username/password/otp
  const correction = detectAuthCorrection(text);
  let justCorrected: 'username' | 'password' | 'otp' | null = null;
  if (correction && conversation.draft.needsLogin) {
    conversation.draft.credentials = clearAuthField(conversation.draft.credentials, correction);
    conversation.draft.authState = nextAuthState(conversation.draft);
    justCorrected = correction;
  }

  // Parse standard auth fields (skip if this was a yes/no answer to the credentials question)
  const isYesNoReply = isNoCredentials(text) || isYesCredentials(text) || !!justCorrected;
  const authPatch = isYesNoReply ? {} : parseAuthFields(text, conversation.draft);
  if (Object.keys(authPatch).length > 0) {
    conversation.draft.credentials = mergeCredentials(conversation.draft.credentials, authPatch);
  }

  // Parse extra inputs (phone, card, custom fields)
  const extrasPatch = extractExtras(text, conversation.draft.credentials.extras);
  if (extrasPatch) {
    conversation.draft.credentials = {
      ...conversation.draft.credentials,
      extras: extrasPatch,
    };
  }

  // Detect matrix test IDs (e.g. "A6, B2, F2" or "run all")
  const isRunAll = /\b(all tests?|run all|full matrix|every test|all flows?)\b/i.test(text);
  if (isRunAll) {
    conversation.draft.selectedFlowClasses = Object.values(MATRIX_ID_MAP);
  } else {
    const matrixIds = extractMatrixIds(text);
    if (matrixIds.length > 0) {
      const flowClasses = matrixIds.map((id) => MATRIX_ID_MAP[id]).filter(Boolean);
      conversation.draft.selectedFlowClasses = [
        ...new Set([...(conversation.draft.selectedFlowClasses ?? []), ...flowClasses]),
      ];
    }
  }

  // Detect and store flow instructions
  const isListRequest = /\b(list|show|what|which).{0,30}(tests?|flows?|matrix|checks?)\b/i.test(text);
  const instruction = extractFlowInstruction(text);
  if (instruction && !isListRequest) {
    conversation.draft.flowInstructions = [
      ...(conversation.draft.flowInstructions ?? []),
      instruction,
    ];
  }

  // Fallback context
  const isAuthOrExtras = Object.keys(authPatch).length > 0 || extrasPatch !== null;
  if (text.length > 20 && !url && !isStartCommand(text) && !isAuthOrExtras && !instruction && !isNoCredentials(text) && !isYesCredentials(text)) {
    conversation.draft.context = conversation.draft.context
      ? `${conversation.draft.context}\n${text}`
      : text;
  }

  conversation.draft.authState = nextAuthState(conversation.draft);

  const missing = missingFields(conversation.draft);
  const readyToStart = missing.length === 0 && isStartCommand(text);

  const replyPatch: Partial<SessionCredentials> = {
    ...authPatch,
    ...(extrasPatch ? { extras: extrasPatch } : {}),
  };

  let reply: string;
  if (isListRequest) {
    reply =
      `Here are all available tests from the exploration matrix. Reference them by ID:\n\n` +
      matrixTestList() +
      `\n\n---\n` +
      `You can say:\n` +
      `- **"run A6, B2, C4"** — pick specific tests\n` +
      `- **"run all"** — run the complete matrix\n` +
      `- **"run all UI tests"** — run by section\n\n` +
      `Current config:\n${summarizeDraft(conversation.draft)}`;
  } else if (justCorrected) {
    const fieldLabel =
      justCorrected === 'username'
        ? 'username / email'
        : justCorrected === 'password'
          ? 'password'
          : 'OTP';
    reply =
      `No problem — cleared the previous ${fieldLabel}. Enter it again.\n\n` +
      authPromptForState(conversation.draft);
  } else {
    reply = buildAssistantReply(conversation.draft, text, replyPatch);
  }

  conversation.messages.push(msg('assistant', reply, { kind: readyToStart ? 'command' : 'setup' }));

  return {
    conversationId: conversation.id,
    messages: conversation.messages,
    draft: conversation.draft,
    readyToStart,
    missing,
    config: readyToStart ? draftToConfig(conversation.draft) : undefined,
  };
}

export function applyProbeToConversation(
  conversation: SetupConversation,
  probe: import('@qa/shared').AuthProbeResult,
): SetupChatResponse {
  applyAuthProbe(conversation.draft, probe);
  conversation.draft.credentialsAsked = true;
  conversation.draft.authState = nextAuthState(conversation.draft);

  const probeMsg = authPromptFromProbe(probe);
  // authPromptFromProbe already spells out exactly what to provide for the detected method
  // (e.g. "phone: ..." for OTP, "username: ... / password: ..." for password) — appending
  // authPromptForState's generic "please provide your username" on top of that just repeats
  // the same ask in different words, reading as two separate questions stacked together.
  const content = probe.requiresAuth
    ? probeMsg
    : `${probeMsg}\n\nTell me what to test, or any extra inputs the site needs (phone, card number, etc.), or say **"start"** for a quick smoke run.`;

  const last = conversation.messages.at(-1);
  if (last?.role === 'assistant') {
    conversation.messages[conversation.messages.length - 1] = msg('assistant', content, {
      kind: 'auth',
    });
  } else {
    conversation.messages.push(msg('assistant', content, { kind: 'auth' }));
  }

  return {
    conversationId: conversation.id,
    messages: conversation.messages,
    draft: conversation.draft,
    readyToStart: false,
    missing: missingFields(conversation.draft),
  };
}

const setupConversations = new Map<string, SetupConversation>();

export function getOrCreateSetupConversation(conversationId?: string): SetupConversation {
  if (conversationId) {
    const existing = setupConversations.get(conversationId);
    if (existing) return existing;
    throw new Error(`Conversation ${conversationId} not found — refresh the chat page.`);
  }
  const conv = createSetupConversation();
  setupConversations.set(conv.id, conv);
  return conv;
}

