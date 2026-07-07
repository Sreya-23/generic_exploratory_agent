import type { Page } from 'playwright';
import type { SessionCredentials } from '@qa/shared';

export interface LoginResult {
  success: boolean;
  message: string;
  needsOtp?: boolean;
}

async function fillFirstMatch(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

async function clickSubmit(page: Page): Promise<void> {
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
    const filledOtp = await fillFirstMatch(page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[name*="code" i]',
      'input[placeholder*="code" i]',
      'input[type="text"]',
    ], creds.otp);

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
