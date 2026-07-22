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

/** Strip accidental wrapping quotes from a credential value. */
export function cleanCredentialValue(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
}

/**
 * Detect "I entered the wrong username / let me re-enter password" style messages.
 * Returns which field the user wants to correct, or null.
 */
export function detectAuthCorrection(text: string): 'username' | 'password' | 'otp' | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;

  // Explicit field labels always win (handled by parseAuthFields); this is for intent-only messages.
  // Allow common typos: usename, user name, agin, mistakely, etc.
  const userWord = String.raw`(?:user\s*names?|usernames?|usenames?|e-?mails?|logins?|user\b)`;
  const passWord = String.raw`(?:pass(?:words?)?|pwd)`;
  const otpWord = String.raw`(?:otp|codes?|verification)`;
  const againWord = String.raw`(?:again|agin|re-?enter|reenter|change|correct|update|fix|reset|clear|mistak\w*|wrong|incorrect)`;

  const wantsUsername =
    new RegExp(`(?:${againWord}).{0,40}${userWord}`, 'i').test(t) ||
    new RegExp(`${userWord}.{0,40}${againWord}`, 'i').test(t) ||
    new RegExp(`(?:give|provide|enter|type|let me).{0,24}(?:the\\s+)?${userWord}`, 'i').test(t);

  const wantsPassword =
    new RegExp(`(?:${againWord}).{0,40}${passWord}`, 'i').test(t) ||
    new RegExp(`${passWord}.{0,40}${againWord}`, 'i').test(t) ||
    new RegExp(`(?:give|provide|enter|type|let me).{0,24}(?:the\\s+)?${passWord}.{0,15}(?:again|agin|re-?enter)`, 'i').test(t);

  const wantsOtp =
    new RegExp(`(?:${againWord}).{0,40}${otpWord}`, 'i').test(t) ||
    new RegExp(`${otpWord}.{0,40}${againWord}`, 'i').test(t);

  // Prefer the most specific field mentioned; username before password if both match vaguely.
  if (wantsUsername && !wantsPassword) return 'username';
  if (wantsPassword && !wantsUsername) return 'password';
  if (wantsOtp) return 'otp';
  if (wantsUsername) return 'username';
  if (wantsPassword) return 'password';

  // Vague "I made a mistake / reenter" while collecting auth — default to username
  // (most common: user just saved username and wants to fix it before password)
  if (
    /(?:mistak\w*|wrong|re-?enter|reenter|start over|try again|do again)/i.test(t) &&
    t.split(/\s+/).length <= 12
  ) {
    return 'username';
  }

  return null;
}

/**
 * Clear a credential field so the user can re-enter it.
 * Clearing username also clears password/otp (dependent fields).
 */
export function clearAuthField(
  creds: SessionCredentials,
  field: 'username' | 'password' | 'otp',
): SessionCredentials {
  const next = { ...creds };
  if (field === 'username') {
    delete next.username;
    delete next.password;
    delete next.otp;
  } else if (field === 'password') {
    delete next.password;
    delete next.otp;
  } else {
    delete next.otp;
  }
  return next;
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
    patch.username = cleanCredentialValue(userLabelMatch[1]);
    patch.type = 'login';
  }

  const passLabelMatch = trimmed.match(/^(?:pass(?:words?)?|pwd)\s*[:=]\s*(.+)$/i);
  if (passLabelMatch) {
    patch.password = cleanCredentialValue(passLabelMatch[1]);
    patch.type = 'login';
  }

  const otpLabelMatch = trimmed.match(/^(?:otp|code|verification)\s*[:=]\s*(.+)$/i);
  if (otpLabelMatch) {
    patch.otp = cleanCredentialValue(otpLabelMatch[1]);
    patch.type = 'login';
  }

  const emailMatch = trimmed.match(/(?:email|users?names?|user(?:name)?)\s*[:=]\s*(\S+)/i);
  if (emailMatch) {
    patch.username = cleanCredentialValue(emailMatch[1]);
    patch.type = 'login';
  }

  const passMatch = trimmed.match(/(?:pass(?:word)?)\s*[:=]\s*(\S+)/i);
  if (passMatch) {
    patch.password = cleanCredentialValue(passMatch[1]);
    patch.type = 'login';
  }

  const otpMatch = trimmed.match(/(?:otp|code)\s*[:=]\s*(\S+)/i);
  if (otpMatch) {
    patch.otp = cleanCredentialValue(otpMatch[1]);
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

  // OAuth / SSO — user pastes cookies from DevTools
  const cookiesMatch = trimmed.match(/^cookies?\s*[:=]\s*(.+)$/i);
  if (cookiesMatch) {
    patch.type = 'bearer'; // reuse bearer flow, injected as cookies
    patch.cookieString = cookiesMatch[1].trim();
    patch.authMethod = 'oauth';
  }

  // Magic-link — user pastes the URL from their email
  const magicLinkMatch = trimmed.match(/^magic-?link\s*[:=]\s*(https?:\/\/\S+)/i);
  if (magicLinkMatch) {
    patch.type = 'login';
    patch.magicLinkUrl = magicLinkMatch[1].trim();
    patch.authMethod = 'magic-link';
  }

  // Phone number — for OTP-based login
  const phoneMatch = trimmed.match(/^phone\s*[:=]\s*([+\d\s()-]{7,20})/i);
  if (phoneMatch) {
    patch.type = 'login';
    patch.username = phoneMatch[1].trim();
    patch.authMethod = 'otp';
  }

  const combo = trimmed.match(
    /(?:user(?:name)?|email)\s*[:=]\s*(\S+)\s+(?:pass(?:word)?)\s*[:=]\s*(\S+)(?:\s+(?:otp|code)\s*[:=]\s*(\S+))?/i,
  );
  if (combo) {
    patch.type = 'login';
    patch.username = cleanCredentialValue(combo[1]);
    patch.password = cleanCredentialValue(combo[2]);
    if (combo[3]) patch.otp = cleanCredentialValue(combo[3]);
    patch.authMethod = combo[3] ? 'password-otp' : 'password';
  }

  // Bare OTP
  if (/^\d{4,8}$/.test(trimmed) && authState === 'awaiting_otp') {
    patch.otp = cleanCredentialValue(trimmed);
    patch.type = 'login';
  }

  // Bare password — never treat correction-intent phrases as a password
  if (
    authState === 'awaiting_password' &&
    !passMatch &&
    !detectAuthCorrection(trimmed) &&
    trimmed.length >= 2 &&
    !trimmed.includes(' ') &&
    !/^(start|public|password|otp)$/i.test(trimmed)
  ) {
    patch.password = cleanCredentialValue(trimmed);
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
      patch.username = cleanCredentialValue(afterColon);
      patch.type = 'login';
    }
  }

  // Bare username / email (no prefix required)
  // Also allow while awaiting_password if the message is clearly a labeled username
  // (handled above) OR a bare token when user is correcting — correction clears state first.
  if (
    authState === 'awaiting_username' &&
    !patch.username &&
    !trimmed.includes(' ') &&
    trimmed.length >= 2 &&
    !/^(start|public|password|otp|api)$/i.test(trimmed)
  ) {
    patch.username = cleanCredentialValue(
      trimmed.replace(/^(?:email|users?names?|user(?:name)?)\s*[:=]\s*/i, ''),
    );
    patch.type = 'login';
  }

  if (
    authState === 'awaiting_password' &&
    !patch.password &&
    !detectAuthCorrection(trimmed) &&
    /^[^:]{1,24}\s*:\s*\S+\s*$/.test(trimmed)
  ) {
    const afterColon = trimmed.split(':').slice(1).join(':').trim();
    // If the label looks like username/email, treat as username correction instead
    const label = trimmed.split(':')[0].trim().toLowerCase();
    if (/^(e-?mail|users?names?|user(?:name)?|login|account)$/i.test(label)) {
      patch.username = cleanCredentialValue(afterColon);
      patch.type = 'login';
    } else if (afterColon) {
      patch.password = cleanCredentialValue(afterColon);
      patch.type = 'login';
    }
  }

  // Allow `username: ...` while awaiting password to overwrite a mistaken username
  if (
    authState === 'awaiting_password' &&
    patch.username &&
    !patch.password
  ) {
    // Clearing password so nextAuthState asks for password again after username fix
    patch.password = undefined;
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
  const merged: SessionCredentials = {
    ...current,
    ...patch,
    type: patch.type ?? current.type,
    authMethod: patch.authMethod ?? current.authMethod,
  };
  // Explicit undefined in patch means "clear this field" (e.g. username correction)
  if ('password' in patch && patch.password === undefined) delete merged.password;
  if ('otp' in patch && patch.otp === undefined) delete merged.otp;
  if ('username' in patch && patch.username === undefined) delete merged.username;
  // Changing username invalidates dependent secrets unless a new password was also provided
  if (patch.username && !('password' in patch && patch.password !== undefined)) {
    delete merged.password;
    delete merged.otp;
  }
  return merged;
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
    return (
      `✅ **${probe.targetUrl}** looks publicly accessible — no login detected.\n\n` +
      `I'll explore it directly. If the site does require credentials, tell me now:\n` +
      `- \`username: your@email.com\`\n` +
      `- \`password: yourpassword\`\n` +
      `- \`phone: +919876543210\` (for OTP-based login)`
    );
  }

  const site = probe.title || probe.targetUrl;

  switch (probe.suggestedMethod) {
    case 'oauth':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Social / OAuth login** (Google, Apple, etc.)\n\n` +
        `Since OAuth redirects through a third-party, I can't automate it directly. ` +
        `Please paste your **session cookies** from a logged-in browser tab:\n\n` +
        `1. Open the site in Chrome and log in manually\n` +
        `2. Open DevTools → Application → Cookies → copy all cookies for this domain\n` +
        `3. Paste them here as: \`cookies: name1=val1; name2=val2\`\n\n` +
        `Or provide a \`bearer: <token>\` if the site uses a JWT.`
      );

    case 'magic-link':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Magic link login** (email → click link)\n\n` +
        `Please provide your email and I'll trigger the magic link:\n` +
        `- \`email: your@email.com\`\n\n` +
        `After the email arrives, paste the full login link here:\n` +
        `- \`magic-link: https://...\``
      );

    case 'saml':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Enterprise SSO / SAML login**\n\n` +
        `SAML redirects through your company's identity provider. Please either:\n` +
        `- Paste your session cookies: \`cookies: name=val; name2=val2\`\n` +
        `- Or paste a bearer token: \`bearer: <token>\`\n\n` +
        `You can find these in DevTools → Application → Cookies/Local Storage after logging in.`
      );

    case 'otp':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Phone / OTP login**\n\n` +
        `Please provide your phone number or email:\n` +
        `- \`phone: +919876543210\`\n` +
        `- or \`email: your@email.com\`\n\n` +
        `I'll trigger the OTP and ask for the code once it arrives on your phone.`
      );

    case 'password-otp':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Password + OTP (two-factor)**\n\n` +
        `Please provide:\n` +
        `- \`username: your@email.com\`\n` +
        `- \`password: yourpassword\`\n\n` +
        `After login, I'll ask for your authenticator/SMS code.`
      );

    case 'password':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Username + Password**\n\n` +
        `Please provide:\n` +
        `- \`username: your@email.com\`\n` +
        `- \`password: yourpassword\``
      );

    case 'api-key':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **API key authentication**\n\n` +
        `Please provide:\n` +
        `- \`api-key: your_key_here\``
      );

    case 'bearer':
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `Detected: **Bearer token authentication**\n\n` +
        `Please provide:\n` +
        `- \`bearer: your_token_here\``
      );

    default:
      return (
        `🔐 **Login required** on "${site}".\n\n` +
        `I detected a login page but couldn't determine the exact method. ` +
        `Please tell me the login type:\n\n` +
        `- \`username: ...\` + \`password: ...\` (standard login)\n` +
        `- \`phone: +91...\` (OTP login)\n` +
        `- \`cookies: name=val; ...\` (OAuth/SSO — paste from DevTools)\n` +
        `- \`bearer: ...\` (token-based)`
      );
  }
}
