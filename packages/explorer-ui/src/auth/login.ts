import type { Page } from 'playwright';
import type { SessionCredentials } from '@qa/shared';
import { findVisibleErrorText, isLoginWallPage, fillOtpInput } from '../flows/helpers.js';

export interface LoginResult {
  success: boolean;
  message: string;
  needsOtp?: boolean;
}

/**
 * Waits (bounded, once) for ANY candidate selector to become visible before giving up —
 * see the equivalent helper in ui-executor.ts for why an instant same-tick check is
 * unreliable against slow-loading/hydrating login forms.
 */
async function fillFirstMatch(
  page: Page,
  selectors: string[],
  value: string,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    await page.locator(selectors.join(', ')).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

/**
 * Check any visible, unchecked consent/terms checkbox before submitting a login/signup form.
 * Many apps disable the submit button until "I agree to Terms and Conditions" (or similar) is
 * checked — clicking a disabled submit silently does nothing, so login stalls on the same
 * screen forever with no visible error. Checking every visible unchecked box is safe here:
 * login/signup forms essentially never have unrelated checkboxes to worry about.
 */
export async function checkConsentCheckboxes(page: Page): Promise<void> {
  const nativeBoxes = page.locator('input[type="checkbox"]:visible');
  const nativeCount = await nativeBoxes.count().catch(() => 0);
  for (let i = 0; i < nativeCount; i++) {
    const box = nativeBoxes.nth(i);
    if (!(await box.isChecked().catch(() => true))) {
      // force: true — many custom-styled checkboxes render a visual SVG/icon overlay
      // directly on top of the native (often visually hidden) <input>, which fails
      // Playwright's actionability check ("subtree intercepts pointer events") even though
      // a real user can click it fine. Without force, this silently times out and gets
      // swallowed by the catch below, leaving the box unchecked and — on sites that gate
      // their submit button on it — makes every submit after this a silent no-op.
      await box.check({ timeout: 2000, force: true }).catch(() => {});
    }
  }

  const ariaBoxes = page.locator('[role="checkbox"]:visible');
  const ariaCount = await ariaBoxes.count().catch(() => 0);
  for (let i = 0; i < ariaCount; i++) {
    const box = ariaBoxes.nth(i);
    const checked = (await box.getAttribute('aria-checked').catch(() => 'true')) === 'true';
    if (!checked) {
      await box.click({ timeout: 2000, force: true }).catch(() => {});
    }
  }
}

async function clickSubmit(page: Page): Promise<void> {
  await checkConsentCheckboxes(page);
  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Continue"), button:has-text("Verify"), button:has-text("Submit")',
  ).first();
  if ((await submit.count()) > 0) {
    await submit.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  }
}

export async function performLogin(page: Page, creds: SessionCredentials): Promise<LoginResult> {
  if (creds.type === 'none') {
    return { success: true, message: 'No login required' };
  }

  if (creds.type === 'api-key' || creds.type === 'bearer') {
    return { success: true, message: 'API auth via headers' };
  }

  const method = creds.authMethod ?? 'password';

  if (method === 'otp' || (method === 'password-otp' && creds.otp && !creds.password)) {
    if (!creds.username) {
      return { success: false, message: 'Username/email required for OTP login' };
    }
    await fillFirstMatch(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[type="tel"]',
      // Mobile-first login forms (common for fintech/consumer apps) often use a plain
      // type="text" field labeled by name/placeholder rather than type="tel" — matching
      // only type="tel" misses these entirely.
      'input[name*="mobile" i]',
      'input[name*="phone" i]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
    ], creds.username);
    await clickSubmit(page);
  }

  if ((method === 'password' || method === 'password-otp') && creds.username && creds.password) {
    await fillFirstMatch(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[type="text"]',
    ], creds.username);

    const filledPass = await fillFirstMatch(page, [
      'input[type="password"]',
      'input[name*="pass" i]',
    ], creds.password);

    if (!filledPass) {
      return { success: false, message: 'Password field not found' };
    }

    await clickSubmit(page);

    const otpVisible = (await page.locator(
      'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i]',
    ).count()) > 0;

    if (otpVisible && method === 'password-otp' && !creds.otp) {
      return { success: false, message: 'OTP required after password', needsOtp: true };
    }
  }

  if (creds.otp && (method === 'otp' || method === 'password-otp')) {
    const filledOtp = await fillOtpInput(page, creds.otp);

    if (!filledOtp) {
      return { success: false, message: 'OTP field not found' };
    }

    await clickSubmit(page);
  }

  const stillOnLogin = (await page.locator('input[type="password"]').count()) > 0
    && !(await page.locator('input[type="password"]').first().inputValue().catch(() => ''));
  const hasOtpOnly = (await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i]').count()) > 0;

  if (stillOnLogin && creds.password) {
    const passVal = await page.locator('input[type="password"]').first().inputValue().catch(() => '');
    if (passVal) {
      return { success: false, message: 'Login may have failed — still on login page', needsOtp: hasOtpOnly };
    }
  }

  // Pure OTP flows (no password field at all) never trigger the check above, so a rejected
  // or stale OTP — e.g. one supplied up front before the site ever actually sent a code, so
  // it's guaranteed wrong — fell straight through to a blind "success" with nothing checking
  // whether the attempt actually got anywhere. isLoginWallPage is the same battle-tested
  // heuristic used elsewhere (ensureAuthenticatedLanding) to detect "still not logged in" —
  // it covers not just a lingering OTP field but any other rejection state the site shows
  // (e.g. this app's "added you to our waitlist" response for an unrecognized number, which
  // has neither a leftover OTP field nor a styled error message, but does still show the
  // same phone input + Continue button that was there before).
  if (creds.otp && (method === 'otp' || method === 'password-otp') && !creds.password) {
    if (await isLoginWallPage(page)) {
      const errorText = await findVisibleErrorText(page, 500);
      return {
        success: false,
        message: errorText
          ? `OTP submission produced an error: "${errorText.slice(0, 120)}"`
          : 'OTP submitted but still on the login step — the code or number was likely rejected',
      };
    }
  }

  return { success: true, message: 'Login flow completed' };
}

export async function detectLoginWall(page: Page): Promise<boolean> {
  const hasPassword = (await page.locator('input[type="password"]').count()) > 0;
  const hasOtp = (await page.locator(
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="code" i]',
  ).count()) > 0;
  // Phone-based login (no password field — common in consumer apps)
  const hasPhone = (await page.locator(
    'input[type="tel"], input[name*="phone" i], input[name*="mobile" i], ' +
    'input[placeholder*="phone" i], input[placeholder*="mobile" i]',
  ).count()) > 0;
  const hasLoginBtn = (await page.locator(
    'button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), ' +
    'button:has-text("Continue"), button:has-text("Send OTP"), button:has-text("Get OTP"), ' +
    'button[type="submit"]',
  ).count()) > 0;
  // Also check URL path as a fast signal
  const urlPath = page.url().toLowerCase();
  const urlHintsLogin =
    urlPath.includes('/login') || urlPath.includes('/signin') ||
    urlPath.includes('/sign-in') || urlPath.includes('/auth');

  return hasPassword || (hasOtp && hasLoginBtn) || (hasPhone && hasLoginBtn) || urlHintsLogin;
}
