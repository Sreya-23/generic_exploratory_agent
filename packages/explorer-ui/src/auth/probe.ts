import type { AuthMethod, AuthProbeResult } from '@qa/shared';
import { chromium } from 'playwright';

export async function probeAuth(targetUrl: string): Promise<AuthProbeResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await page.title();
    const hasPassword = (await page.locator('input[type="password"]').count()) > 0;
    const hasOtp = (await page.locator(
      'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[placeholder*="code" i], input[placeholder*="OTP" i]',
    ).count()) > 0;
    const hasEmail = (await page.locator(
      'input[type="email"], input[name*="email" i], input[name*="user" i]',
    ).count()) > 0;
    const loginButton = (await page.locator(
      'button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), input[type="submit"]',
    ).count()) > 0;

    const requiresAuth = hasPassword || (hasOtp && loginButton);

    let suggestedMethod: AuthMethod = 'none';
    if (requiresAuth) {
      if (hasPassword && hasOtp) suggestedMethod = 'password-otp';
      else if (hasOtp && !hasPassword) suggestedMethod = 'otp';
      else if (hasPassword) suggestedMethod = hasEmail ? 'password' : 'password';
      else suggestedMethod = 'unknown';
    }

    return {
      targetUrl,
      title,
      requiresAuth,
      suggestedMethod,
      hasPasswordField: hasPassword,
      hasOtpField: hasOtp,
      hasUsernameField: hasEmail,
    };
  } catch (err) {
    return {
      targetUrl,
      title: '',
      requiresAuth: false,
      suggestedMethod: 'unknown',
      hasPasswordField: false,
      hasOtpField: false,
      hasUsernameField: false,
      error: (err as Error).message,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
