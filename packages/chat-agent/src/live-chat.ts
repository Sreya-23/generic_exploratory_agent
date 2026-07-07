import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  Finding,
  LiveChatResponse,
  SessionCredentials,
  SessionEvent,
  SessionState,
} from '@qa/shared';
import { mergeCredentials, parseAuthFields, credentialsComplete, effectiveAuthState, authPromptForState } from './auth-chat.js';

/** Parse key:value extras from free-form text. Returns null if nothing found. */
function parseExtras(text: string, existing?: Record<string, string>): Record<string, string> | null {
  if (/https?:\/\//i.test(text)) return null;
  const KNOWN_CRED_KEYS = /^(email|user(?:name)?|pass(?:word)?|pwd|otp|code|api[- ]?key|bearer|login|account)$/i;
  const extras: Record<string, string> = { ...(existing ?? {}) };
  const matches = [...text.matchAll(/\b([a-zA-Z][a-zA-Z0-9_-]{1,29})\s*[:=]\s*([^\s,][^,\n]*?)(?=\s*[,\n]|$)/g)];
  let added = false;
  for (const m of matches) {
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (KNOWN_CRED_KEYS.test(key) || !value || key.length < 2) continue;
    extras[key] = value;
    added = true;
  }
  return added ? extras : null;
}

function msg(role: ChatMessage['role'], content: string, meta?: ChatMessage['meta']): ChatMessage {
  return { id: randomUUID(), role, content, timestamp: new Date().toISOString(), meta };
}

export function sessionEventToChatMessage(event: SessionEvent): ChatMessage | null {
  switch (event.type) {
    case 'auth:required': {
      const p = event.payload as { message?: string; suggestedMethod?: string };
      return msg(
        'assistant',
        p.message ??
          `🔐 **Login required** before I can explore this app.\n\nReply with:\n- \`email: you@co.com password: secret\`\n- \`otp: 123456\` (if OTP-only)\n- \`email: you@co.com password: secret otp: 123456\` (password + OTP)`,
        { kind: 'auth' },
      );
    }

    case 'auth:otp_required':
      return msg(
        'assistant',
        `📱 **OTP required** — enter the code you received.\n\nExample: \`otp: 123456\``,
        { kind: 'auth' },
      );

    case 'session:started':
      return msg('assistant', 'Exploration started. Logging in if needed, then running test flows...', {
        kind: 'progress',
      });

    case 'task:started': {
      const task = event.payload as { title?: string };
      return msg('assistant', `▶ Running: **${task.title ?? 'task'}**`, { kind: 'progress' });
    }

    case 'session:progress':
      return null;

    case 'log': {
      const { message } = event.payload as { message: string };
      if (message.startsWith('[Auth]')) {
        return msg('assistant', message.replace('[Auth] ', '🔐 '), { kind: 'auth' });
      }
      return msg('assistant', message, { kind: 'progress' });
    }

    case 'session:finding': {
      const f = event.payload as Finding;
      const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' }[f.severity];
      return msg(
        'assistant',
        `${icon} **[${f.severity.toUpperCase()}]** ${f.title}\n_${f.actual}_`,
        { kind: 'finding', severity: f.severity, findingId: f.id },
      );
    }

    case 'session:completed': {
      const s = event.payload as SessionState;
      return msg(
        'assistant',
        `✅ Exploration complete — **${s.findings.length} findings** recorded.`,
        { kind: 'status' },
      );
    }

    case 'session:failed': {
      const err = (event.payload as { error?: string }).error ?? 'Unknown error';
      return msg('assistant', `❌ Exploration failed: ${err}`, { kind: 'status' });
    }

    case 'session:paused':
      return msg('assistant', '⏸ Exploration paused.', { kind: 'status' });

    case 'site:classified': {
      const c = event.payload as { siteType: string; confidence: number; inferredJourneys: string[] };
      return msg(
        'assistant',
        `🔍 Site classified as **${c.siteType}** (${Math.round(c.confidence * 100)}% confidence)\n\nJourneys queued: ${c.inferredJourneys.slice(0, 3).join(', ')}`,
        { kind: 'progress' },
      );
    }

    default:
      return null;
  }
}

export function processLiveMessage(
  session: SessionState,
  userText: string,
): LiveChatResponse & { credentials?: SessionCredentials; authState?: SessionState['authState'] } {
  const text = userText.trim().toLowerCase();
  const messages: ChatMessage[] = [msg('user', userText)];

  if (session.status === 'awaiting_auth') {
    const draft = {
      depth: session.config.depth,
      areas: session.config.areas,
      targetUrl: session.config.targetUrl,
      credentials: session.config.credentials ?? { type: 'login' as const },
      authProbe: session.authProbe,
      needsLogin: true,
    };

    const patch = parseAuthFields(userText, draft);
    if (Object.keys(patch).length > 0) {
      const merged = mergeCredentials(draft.credentials, patch);
      const nextState = effectiveAuthState({ ...draft, credentials: merged });

      if (credentialsComplete({ ...draft, credentials: merged })) {
        messages.push(
          msg('assistant', '✅ Credentials complete. Resuming exploration...', { kind: 'auth' }),
        );
        return { messages, action: 'resume', credentials: merged, authState: 'ready' };
      }

      const prompt = authPromptForState({ ...draft, credentials: merged, authState: nextState });
      const ack =
        patch.username && nextState === 'awaiting_password'
          ? '✅ Username saved.'
          : patch.password && nextState === 'awaiting_otp'
            ? '✅ Password saved.'
            : '✅ Got it.';
      messages.push(msg('assistant', `${ack}\n\n${prompt}`, { kind: 'auth' }));
      return { messages, action: 'update_auth', credentials: merged, authState: nextState };
    }

    messages.push(
      msg(
        'assistant',
        authPromptForState({ ...draft, authState: session.authState }) ||
          `Please provide login details:\n- \`email: user@test.com\`\n- \`password: secret\`\n- \`otp: 123456\``,
        { kind: 'auth' },
      ),
    );
    return { messages, action: 'none' };
  }

  if (/^(pause|stop|halt)\b/.test(text)) {
    messages.push(msg('assistant', 'Pausing exploration...', { kind: 'command' }));
    return { messages, action: 'pause' };
  }

  if (/^(status|progress)\b/.test(text)) {
    messages.push(
      msg(
        'assistant',
        `**Status:** ${session.status}\n**Progress:** ${session.progress.percent}% (${session.progress.completedTasks}/${session.progress.totalTasks})\n**Findings:** ${session.findings.length}`,
        { kind: 'status' },
      ),
    );
    return { messages, action: 'none' };
  }

  const credPatch = parseAuthFields(userText, {
    depth: session.config.depth,
    areas: session.config.areas,
    targetUrl: session.config.targetUrl,
    credentials: session.config.credentials ?? { type: 'login' },
    authProbe: session.authProbe,
    needsLogin: session.config.credentials?.type === 'login',
  });
  if (credPatch && (credPatch.password || credPatch.otp || credPatch.username)) {
    const merged = mergeCredentials(session.config.credentials ?? { type: 'login' }, credPatch);
    messages.push(msg('assistant', '✅ Updated credentials.', { kind: 'auth' }));
    return { messages, action: 'resume', credentials: merged };
  }

  // Handle explicit "skip" reply to a pre-action gate prompt
  // User says: "skip", "no", "skip this", "don't do it", "ignore", "cancel"
  const isSkipReply = /^(skip|no|cancel|ignore|don'?t|not now|pass)\b/i.test(userText.trim());
  if (isSkipReply) {
    const existingCreds = session.config.credentials ?? { type: 'none' as const };
    const skipExtras: Record<string, string> = {
      ...(existingCreds.extras ?? {}),
      _user_skip: 'true',  // flag that the user explicitly chose to skip the pending action
    };
    const merged: SessionCredentials = { ...existingCreds, extras: skipExtras };
    messages.push(
      msg(
        'assistant',
        '⏭️ Got it — skipping that action. The agent will move on to the next test.',
        { kind: 'status' },
      ),
    );
    return { messages, action: 'update_auth', credentials: merged };
  }

  // Check for extra key:value inputs (card, phone, account, etc.) provided in response to pre-action prompts
  const extrasPatch = parseExtras(userText, session.config.credentials?.extras);
  if (extrasPatch) {
    // Clear any previous skip flag if user is now providing data
    delete extrasPatch['_user_skip'];
    const existingCreds = session.config.credentials ?? { type: 'none' as const };
    const merged: SessionCredentials = { ...existingCreds, extras: extrasPatch };
    const keys = Object.keys(extrasPatch).filter((k) => !k.startsWith('_')).join(', ');
    messages.push(
      msg(
        'assistant',
        `✅ Saved: **${keys}**\n\nThese will be used for any pending or upcoming risky actions. The agent will use this data in the next applicable flow.`,
        { kind: 'status' },
      ),
    );
    return { messages, action: 'update_auth', credentials: merged };
  }

  if (/critical|show important/.test(text)) {
    const critical = session.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    if (!critical.length) {
      messages.push(msg('assistant', 'No critical/high findings yet.', { kind: 'status' }));
    } else {
      for (const f of critical) {
        messages.push(
          msg('assistant', `**[${f.severity.toUpperCase()}]** ${f.title}`, {
            kind: 'finding',
            severity: f.severity,
          }),
        );
      }
    }
    return { messages, action: 'none' };
  }

  if (/findings|issues|bugs/.test(text)) {
    messages.push(
      msg(
        'assistant',
        session.findings.length
          ? `Found **${session.findings.length}** issues. Say "show critical" for top ones.`
          : 'No findings yet.',
        { kind: 'status' },
      ),
    );
    return { messages, action: 'none' };
  }

  messages.push(
    msg(
      'assistant',
      `Exploring **${session.config.targetUrl}**. Try "status", "show findings", or provide login: \`email: x password: y\``,
      { kind: 'status' },
    ),
  );
  return { messages, action: 'none' };
}

export class LiveChatStore {
  private histories = new Map<string, ChatMessage[]>();

  getHistory(sessionId: string): ChatMessage[] {
    return this.histories.get(sessionId) ?? [];
  }

  append(sessionId: string, ...messages: ChatMessage[]): ChatMessage[] {
    const existing = this.histories.get(sessionId) ?? [];
    const updated = [...existing, ...messages];
    this.histories.set(sessionId, updated.slice(-200));
    return this.histories.get(sessionId)!;
  }

  initSession(sessionId: string, targetUrl: string): ChatMessage[] {
    const welcome = msg(
      'assistant',
      [
        `Connected to **${targetUrl}**.`,
        ``,
        `I'll automatically run all tests. You can interact here at any time:`,
        `- If login is needed I'll ask for credentials`,
        `- Before risky actions (payment, purchase, sending a link) I'll ask for your confirmation`,
        `- Reply with any missing data: \`card: 4111111111111111\`  \`phone: +91 9876543210\``,
        ``,
        `Say **"status"** to check progress or **"pause"** to stop.`,
      ].join('\n'),
      { kind: 'status' },
    );
    this.histories.set(sessionId, [welcome]);
    return [welcome];
  }
}

export const liveChatStore = new LiveChatStore();
