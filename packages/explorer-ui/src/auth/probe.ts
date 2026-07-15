import type { AuthMethod, AuthProbeResult } from '@qa/shared';
import { chromium, type Browser, type BrowserContext } from 'playwright';

export async function probeAuth(targetUrl: string): Promise<AuthProbeResult> {
  // Fast URL-path check — if the path itself is a login route, we already know
  const urlPath = (() => {
    try {
      return new URL(targetUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const urlHintsLogin =
    urlPath.includes('/login') ||
    urlPath.includes('/signin') ||
    urlPath.includes('/sign-in') ||
    urlPath.includes('/auth') ||
    urlPath.includes('/sso');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // Use 'load' (waits for JS to run) instead of 'domcontentloaded' (fires before hydration).
    // Falls back gracefully on slow sites via timeout.
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 }).catch(() =>
      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
    );

    // Give SPA frameworks (React/Vue/Angular) extra time to hydrate and render the form
    await page.waitForTimeout(1500);

    const title = await page.title();

    const hasPassword = (await page.locator('input[type="password"]').count()) > 0;

    const hasOtp =
      (await page.locator(
        'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], ' +
          'input[name*="code" i], input[placeholder*="code" i], input[placeholder*="OTP" i]',
      ).count()) > 0;

    const hasEmail =
      (await page.locator(
        'input[type="email"], input[name*="email" i], input[name*="user" i], input[name*="login" i]',
      ).count()) > 0;

    // Phone-based login (consumer apps — OTP sent via SMS)
    const hasPhone =
      (await page.locator(
        'input[type="tel"], input[name*="phone" i], input[name*="mobile" i], ' +
          'input[placeholder*="phone" i], input[placeholder*="mobile" i], ' +
          'input[placeholder*="number" i]',
      ).count()) > 0;

    const loginButton =
      (await page.locator(
        'button[type="submit"], input[type="submit"], ' +
          'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), ' +
          'button:has-text("Continue"), button:has-text("Send OTP"), button:has-text("Get OTP"), ' +
          'button:has-text("Send code"), button:has-text("Verify")',
      ).count()) > 0;

    // OAuth / Social login buttons (Google, Apple, Facebook, Microsoft, GitHub, etc.)
    const hasOAuth =
      (await page.locator(
        'button:has-text("Continue with Google"), button:has-text("Sign in with Google"), ' +
          'button:has-text("Log in with Google"), a:has-text("Continue with Google"), ' +
          'button:has-text("Continue with Apple"), button:has-text("Sign in with Apple"), ' +
          'button:has-text("Continue with Facebook"), button:has-text("Continue with Microsoft"), ' +
          'button:has-text("Continue with GitHub"), button:has-text("Sign in with GitHub"), ' +
          '[class*="google-btn"], [class*="google-login"], [class*="social-login"], ' +
          '[data-provider="google"], [data-provider="apple"], [data-provider="facebook"]',
      ).count()) > 0;

    // Magic-link login (enter email → click link in email)
    const hasMagicLink =
      (await page.locator(
        'button:has-text("Send magic link"), button:has-text("Email me a link"), ' +
          'button:has-text("Send login link"), button:has-text("Get link"), ' +
          'button:has-text("Send link"), button:has-text("Magic link"), ' +
          'a:has-text("magic link"), [class*="magic-link"]',
      ).count()) > 0;

    // SAML / Enterprise SSO (redirect to company IdP)
    const hasSaml =
      (await page.locator(
        'button:has-text("Sign in with SSO"), button:has-text("Enterprise SSO"), ' +
          'button:has-text("SAML"), button:has-text("Sign in with your organization"), ' +
          'button:has-text("Company login"), a[href*="saml"], a[href*="sso"]',
      ).count()) > 0;

    // Determine auth requirement
    const domHintsAuth =
      hasPassword ||
      hasOAuth ||
      hasMagicLink ||
      hasSaml ||
      (hasOtp && loginButton) ||
      (hasPhone && loginButton);
    const requiresAuth = domHintsAuth || urlHintsLogin;

    // Determine suggested method (most specific first)
    let suggestedMethod: AuthMethod = 'none';
    if (requiresAuth) {
      if (hasSaml) suggestedMethod = 'saml';
      else if (hasOAuth && !hasPassword && !hasPhone) suggestedMethod = 'oauth';
      else if (hasMagicLink && !hasPassword) suggestedMethod = 'magic-link';
      else if (hasPassword && hasOtp) suggestedMethod = 'password-otp';
      else if (hasOtp && !hasPassword) suggestedMethod = 'otp';
      else if (hasPhone && !hasPassword) suggestedMethod = 'otp';
      else if (hasPassword) suggestedMethod = 'password';
      else if (hasOAuth) suggestedMethod = 'oauth';
      else if (urlHintsLogin) suggestedMethod = 'unknown';
      else suggestedMethod = 'unknown';
    }

    return {
      targetUrl,
      title,
      requiresAuth,
      suggestedMethod,
      hasPasswordField: hasPassword,
      hasOtpField: hasOtp || hasPhone,
      hasUsernameField: hasEmail || hasPhone,
      hasOAuthButton: hasOAuth,
      hasMagicLink,
      hasSaml,
    } as AuthProbeResult;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // Missing browser: bubble up so chat UI can show install guidance
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(msg)) {
      throw err;
    }
    // On network/timeout error, fall back to URL-path heuristic
    return {
      targetUrl,
      title: '',
      requiresAuth: urlHintsLogin,
      suggestedMethod: urlHintsLogin ? 'unknown' : 'unknown',
      hasPasswordField: false,
      hasOtpField: false,
      hasUsernameField: false,
      error: msg,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
