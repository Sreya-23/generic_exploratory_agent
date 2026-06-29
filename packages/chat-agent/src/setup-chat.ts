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
  credentialsComplete,
  effectiveAuthState,
  mergeCredentials,
  nextAuthState,
  parseAuthFields,
} from './auth-chat.js';

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

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

  return [
    `**Target:** ${draft.targetUrl ?? '(not set)'}`,
    `**Depth:** ${draft.depth}`,
    `**Areas:** ${areas}`,
    `**Auth:** ${creds}`,
    extrasLine,
    instructionsLine,
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
      `Does this site need any credentials or special inputs to use it?\n\n` +
      `- **Login** (username + password)\n` +
      `- **API key** or **bearer token**\n` +
      `- **Phone number**, card, account ID, or any other input the site needs\n` +
      `- Reply **"no"** if it's publicly accessible\n\n` +
      `You can also tell me specific flows to test — e.g. _"test the payment flow"_, _"send a link to +91 9876543210"_`
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
    return `✅ Password saved.\n\n${authPromptForState(draft)}`;
  }
  if (justCaptured?.otp && authState === 'ready') {
    return `✅ OTP saved.\n\n${summarizeDraft(draft)}\n\nSay **"start"** when ready.`;
  }

  if (!credentialsComplete(draft) && authState !== 'ready') {
    const prompt = authPromptForState(draft);
    if (prompt) return prompt;
  }

  if (missing.length === 0) {
    return `Ready to explore:\n\n${summarizeDraft(draft)}\n\nSay **"start"** or click Start Exploration.`;
  }

  return `Got it.\n\n${summarizeDraft(draft)}`;
}

export function createSetupConversation(): SetupConversation {
  const id = randomUUID();
  const welcome = msg(
    'assistant',
    `Hi! I'm your exploratory QA assistant.\n\nPaste a **website URL** to get started. I'll ask about credentials and any specific flows you want tested before running the exploration.\n\nExample: \`https://staging.myapp.com\``,
    { kind: 'setup' },
  );

  return {
    id,
    messages: [welcome],
    draft: {
      depth: 'smoke',
      areas: ['ui', 'chaos'],
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

  // Handle explicit "no credentials" reply
  if (isNoCredentials(text) && !conversation.draft.needsLogin) {
    conversation.draft.credentials = { type: 'none', authMethod: 'none' };
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

  // Parse standard auth fields (skip if this was a yes/no answer to the credentials question)
  const isYesNoReply = isNoCredentials(text) || isYesCredentials(text);
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

  // Detect and store flow instructions
  const instruction = extractFlowInstruction(text);
  if (instruction) {
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
  const reply = buildAssistantReply(conversation.draft, text, replyPatch);
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
  const followUp = authPromptForState(conversation.draft);
  const content = probe.requiresAuth
    ? `${probeMsg}\n\n${followUp}`
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
