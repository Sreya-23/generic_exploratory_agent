import type {
  AuthMethod,
  AuthProbeResult,
  AuthState,
  SessionCredentials,
  SetupDraft,
} from '@qa/shared';

export function effectiveAuthState(draft: SetupDraft): AuthState {
  return nextAuthState(draft);
}

export function credentialsComplete(draft: SetupDraft): boolean {
  const creds = draft.credentials;
  if (!draft.authProbe?.requiresAuth && !draft.needsLogin) return true;
  if (creds.type === 'none' && !draft.authProbe?.requiresAuth) return true;
  if (creds.type === 'api-key' && creds.apiKey) return true;
  if (creds.type === 'bearer' && creds.bearerToken) return true;
  if (creds.type !== 'login' && creds.type !== 'api-key' && creds.type !== 'bearer') return false;

  if (creds.type === 'api-key') return !!creds.apiKey;
  if (creds.type === 'bearer') return !!creds.bearerToken;

  const method = creds.authMethod ?? draft.authProbe?.suggestedMethod ?? 'password';
  if (method === 'password') return !!(creds.username && creds.password);
  if (method === 'otp') return !!(creds.username && creds.otp);
  if (method === 'password-otp') return !!(creds.username && creds.password && creds.otp);
  return !!(creds.username && (creds.password || creds.otp));
}

export function nextAuthState(draft: SetupDraft): AuthState {
  if (!draft.targetUrl) return 'unknown';
  if (draft.credentials.type === 'none' && !draft.authProbe?.requiresAuth && !draft.needsLogin) {
    return 'ready';
  }
  if (!draft.authProbe && !draft.needsLogin) return 'ready';

  const requires = draft.authProbe?.requiresAuth || draft.needsLogin;
  if (!requires) return 'ready';

  const creds = draft.credentials;
  if (creds.type === 'api-key' || creds.type === 'bearer') return credentialsComplete(draft) ? 'ready' : 'awaiting_method';

  if (!creds.authMethod || creds.authMethod === 'unknown') {
    if (draft.authProbe?.suggestedMethod && draft.authProbe.suggestedMethod !== 'unknown') {
      return 'awaiting_username';
    }
    return 'awaiting_method';
  }

  const method = creds.authMethod;
  if (!creds.username) return 'awaiting_username';
  if ((method === 'password' || method === 'password-otp') && !creds.password) return 'awaiting_password';
  if ((method === 'otp' || method === 'password-otp') && !creds.otp) return 'awaiting_otp';

  return 'ready';
}

export function authPromptForState(draft: SetupDraft): string {
  const state = effectiveAuthState(draft);
  const url = draft.targetUrl ?? 'the site';
  const probe = draft.authProbe;

  switch (state) {
    case 'awaiting_method':
      return `🔐 **${url}** appears to require login.\n\nWhat type of authentication does it use?\n- Reply **"password"** — username + password\n- Reply **"otp"** — email/phone + one-time code\n- Reply **"password and otp"** — password then OTP\n- Reply **"api key"** — API token in headers\n- Reply **"public"** — no login needed`;

    case 'awaiting_username':
      return `Please provide your **username or email** for ${url}.\n\nYou can reply with just the username (e.g. \`standard_user\`) or \`username: standard_user\``;

    case 'awaiting_password':
      return `Got it. Now enter the **password**.\n\nExample: \`password: MySecret123\`\n\n_(Sent securely for this session only.)_`;

    case 'awaiting_otp':
      if (probe?.suggestedMethod === 'password-otp' || draft.credentials.authMethod === 'password-otp') {
        return `Password accepted. Enter the **OTP code** you received.\n\nExample: \`otp: 123456\``;
      }
      return `Enter the **OTP / verification code**.\n\nExample: \`otp: 123456\``;

    case 'required':
      return `Login required for **${url}**. Tell me how you authenticate.`;

    default:
      return '';
  }
}

export function applyAuthProbe(draft: SetupDraft, probe: AuthProbeResult): SetupDraft {
  draft.authProbe = probe;
  if (probe.requiresAuth) {
    draft.needsLogin = true;
    if (draft.credentials.type === 'none') {
      draft.credentials = {
        type: 'login',
        authMethod: probe.suggestedMethod === 'unknown' ? undefined : probe.suggestedMethod,
      };
    }
  } else {
    draft.needsLogin = false;
    draft.credentials = { type: 'none', authMethod: 'none' };
  }
  draft.authState = nextAuthState(draft);
  return draft;
}

export function parseAuthFields(
  text: string,
  draft: SetupDraft,
): Partial<SessionCredentials> {
  const lower = text.toLowerCase().trim();
  const patch: Partial<SessionCredentials> = {};
  const authState = effectiveAuthState(draft);
  const trimmed = text.trim();

  if (/^(public|no login|no auth|without login)\b/.test(lower)) {
    return { type: 'none', authMethod: 'none' };
  }

  if (/^password\s*(\+|and|\+)\s*otp|password.?otp|both/.test(lower)) {
    patch.type = 'login';
    patch.authMethod = 'password-otp';
  } else if (/^otp|one.?time|verification code|sms/.test(lower)) {
    patch.type = 'login';
    patch.authMethod = 'otp';
  } else if (/^password$|username.?password|email.?password/.test(lower)) {
    patch.type = 'login';
    patch.authMethod = 'password';
  } else if (/^api.?key|token/.test(lower)) {
    patch.type = 'api-key';
    patch.authMethod = 'api-key';
  } else if (/^bearer/.test(lower)) {
    patch.type = 'bearer';
    patch.authMethod = 'bearer';
  }

  const userLabelMatch = trimmed.match(
    /^(?:e-?mail|users?names?|user(?:name)?|login|account)\s*[:=]\s*(.+)$/i,
  );
  if (userLabelMatch) {
    patch.username = userLabelMatch[1].trim();
    patch.type = 'login';
  }

  const passLabelMatch = trimmed.match(/^(?:pass(?:words?)?|pwd)\s*[:=]\s*(.+)$/i);
  if (passLabelMatch) {
    patch.password = passLabelMatch[1].trim();
    patch.type = 'login';
  }

  const otpLabelMatch = trimmed.match(/^(?:otp|code|verification)\s*[:=]\s*(.+)$/i);
  if (otpLabelMatch) {
    patch.otp = otpLabelMatch[1].trim();
    patch.type = 'login';
  }

  const emailMatch = trimmed.match(/(?:email|users?names?|user(?:name)?)\s*[:=]\s*(\S+)/i);
  if (emailMatch) {
    patch.username = emailMatch[1];
    patch.type = 'login';
  }

  const passMatch = trimmed.match(/(?:pass(?:word)?)\s*[:=]\s*(\S+)/i);
  if (passMatch) {
    patch.password = passMatch[1];
    patch.type = 'login';
  }

  const otpMatch = trimmed.match(/(?:otp|code)\s*[:=]\s*(\S+)/i);
  if (otpMatch) {
    patch.otp = otpMatch[1];
    patch.type = 'login';
  }

  const apiMatch = trimmed.match(/(?:api[- ]?key)\s*[:=]\s*(\S+)/i);
  if (apiMatch) {
    patch.type = 'api-key';
    patch.apiKey = apiMatch[1];
  }

  const bearerMatch = trimmed.match(/(?:bearer)\s*[:=]\s*(\S+)/i);
  if (bearerMatch) {
    patch.type = 'bearer';
    patch.bearerToken = bearerMatch[1];
  }

  const combo = trimmed.match(
    /(?:user(?:name)?|email)\s*[:=]\s*(\S+)\s+(?:pass(?:word)?)\s*[:=]\s*(\S+)(?:\s+(?:otp|code)\s*[:=]\s*(\S+))?/i,
  );
  if (combo) {
    patch.type = 'login';
    patch.username = combo[1];
    patch.password = combo[2];
    if (combo[3]) patch.otp = combo[3];
    patch.authMethod = combo[3] ? 'password-otp' : 'password';
  }

  // Bare OTP
  if (/^\d{4,8}$/.test(trimmed) && authState === 'awaiting_otp') {
    patch.otp = trimmed;
    patch.type = 'login';
  }

  // Bare password
  if (
    authState === 'awaiting_password' &&
    !passMatch &&
    trimmed.length >= 2 &&
    !trimmed.includes(' ') &&
    !/^(start|public|password|otp)$/i.test(trimmed)
  ) {
    patch.password = trimmed;
    patch.type = 'login';
  }

  // e.g. "usernames :standard_user" — any short label before a colon
  if (
    authState === 'awaiting_username' &&
    !patch.username &&
    /^[^:]{1,24}\s*:\s*\S+\s*$/.test(trimmed)
  ) {
    const afterColon = trimmed.split(':').slice(1).join(':').trim();
    if (afterColon) {
      patch.username = afterColon;
      patch.type = 'login';
    }
  }

  // Bare username / email (no prefix required)
  if (
    authState === 'awaiting_username' &&
    !patch.username &&
    !trimmed.includes(' ') &&
    trimmed.length >= 2 &&
    !/^(start|public|password|otp|api)$/i.test(trimmed)
  ) {
    patch.username = trimmed.replace(/^(?:email|users?names?|user(?:name)?)\s*[:=]\s*/i, '');
    patch.type = 'login';
  }

  if (
    authState === 'awaiting_password' &&
    !patch.password &&
    /^[^:]{1,24}\s*:\s*\S+\s*$/.test(trimmed)
  ) {
    const afterColon = trimmed.split(':').slice(1).join(':').trim();
    if (afterColon) {
      patch.password = afterColon;
      patch.type = 'login';
    }
  }

  if (patch.username || patch.password || patch.otp) {
    patch.type = patch.type ?? 'login';
    patch.authMethod =
      patch.authMethod ??
      draft.credentials.authMethod ??
      (draft.authProbe?.suggestedMethod !== 'unknown'
        ? draft.authProbe?.suggestedMethod
        : undefined) ??
      'password';
  }

  return patch;
}

export function mergeCredentials(
  current: SessionCredentials,
  patch: Partial<SessionCredentials>,
): SessionCredentials {
  return {
    ...current,
    ...patch,
    type: patch.type ?? current.type,
    authMethod: patch.authMethod ?? current.authMethod,
  };
}

export function parseLiveCredentials(
  text: string,
  authState?: import('@qa/shared').AuthState,
): Partial<SessionCredentials> | null {
  const draft: SetupDraft = {
    depth: 'smoke',
    areas: ['ui'],
    credentials: { type: 'login' },
    authState: authState ?? 'awaiting_username',
  };
  const patch = parseAuthFields(text, draft);
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

export function authPromptFromProbe(probe: AuthProbeResult): string {
  if (!probe.requiresAuth) {
    return `✅ **${probe.targetUrl}** looks publicly accessible — no login detected.`;
  }

  const methodLabel: Record<AuthMethod, string> = {
    none: 'none',
    password: 'username + password',
    otp: 'OTP / verification code',
    'password-otp': 'password then OTP',
    'api-key': 'API key',
    bearer: 'bearer token',
    unknown: 'login (type unknown)',
  };

  return `🔐 **Login required** on "${probe.title || probe.targetUrl}".\n\nDetected: **${methodLabel[probe.suggestedMethod]}**\n\nI'll ask for the details next.`;
}
