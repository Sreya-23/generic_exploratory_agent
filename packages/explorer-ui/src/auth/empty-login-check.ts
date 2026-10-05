// §4 — Empty-credential login boundary check. Deliberately submitting a WRONG password or
// OTP against a real external account risks tripping that site's own lockout/fraud-alert
// policy — a risk this codebase is not in a position to take on the user's behalf (this
// targets a live production account, not a disposable test one). An EMPTY submission carries
// none of that risk: no real credential guess is made, so it can never count against a
// failed-attempt counter — but it still catches two real, common bugs:
//   1. A login/OTP form that gives the user no feedback at all when submitted blank (client
//      validation silently does nothing, or a request fires and nothing tells the user why
//      it failed).
//   2. The genuinely serious case: blank credentials being accepted as if they were valid.
//
// Runs in its own throwaway browser context, entirely separate from the one
// performSessionLogin() goes on to use for the real login — it must never interfere with,
// consume, or in any way share state with the real login attempt that follows it.
import { chromium } from 'playwright';
import type { ExecutorContext } from '@qa/shared';
import { isLoginWallPage, findVisibleErrorText, waitForRealContent } from '../flows/helpers.js';

const CREDENTIAL_INPUT_SELECTOR =
  'input[type="password"], input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[name*="otp" i], input[name*="code" i], input[aria-label*="otp" i], input[aria-label*="code" i]';
const SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit")';

export async function runEmptyCredentialLoginCheck(ctx: ExecutorContext): Promise<void> {
  const creds = ctx.config.credentials;
  if (!creds || creds.type === 'none' || creds.type === 'bearer' || creds.type === 'api-key') return;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    ctx.onLog(`[LoginBoundary] Could not launch a probe browser — skipping: ${(err as Error).message.slice(0, 150)}`);
    return;
  }

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    try {
      await page.goto(ctx.config.targetUrl, { waitUntil: 'load', timeout: 30000 }).catch(() =>
        page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      );
      await page.waitForTimeout(1500);

      const onLoginWall = await isLoginWallPage(page).catch(() => false);
      if (!onLoginWall) {
        ctx.onLog('[LoginBoundary] Landing page is not a login wall — nothing to boundary-test here');
        return;
      }

      const inputs = page.locator(CREDENTIAL_INPUT_SELECTOR + ':visible');
      const inputCount = await inputs.count().catch(() => 0);
      const submitBtn = page.locator(SUBMIT_SELECTOR).first();
      if (inputCount === 0 || (await submitBtn.count().catch(() => 0)) === 0) {
        ctx.onLog('[LoginBoundary] No login form inputs/submit button found — skipping empty-submission check');
        return;
      }

      // Explicitly clear every candidate field rather than assuming they start blank — some
      // sites prefill a remembered username.
      for (const el of await inputs.all()) {
        await el.fill('').catch(() => {});
      }

      const urlBefore = page.url();
      const responses: number[] = [];
      const onResponse = (res: import('playwright').Response) => {
        const req = res.request();
        if (req.method() === 'POST' && res.url().startsWith(new URL(urlBefore).origin)) {
          responses.push(res.status());
        }
      };
      page.on('response', onResponse);

      await submitBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await waitForRealContent(page).catch(() => {});
      page.off('response', onResponse);

      const stillOnLoginWall = await isLoginWallPage(page).catch(() => true);
      const errorText = await findVisibleErrorText(page, 500);
      const urlChanged = page.url() !== urlBefore;

      if (!stillOnLoginWall && urlChanged) {
        // The one outcome worth a high-severity finding regardless of everything else —
        // blank credentials should never be treated as valid.
        ctx.onFinding({
          severity: 'high',
          area: 'UI-Journey',
          title: 'Login form accepts an empty-credentials submission',
          steps: [`Open ${ctx.config.targetUrl}`, 'Leave all login fields blank', 'Click the submit/login button'],
          expected: 'Blank credentials must always be rejected, never treated as a valid login',
          actual: `Submitting the login form with every field left blank navigated away from the login page to ${page.url()}`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: urlBefore,
          confidence: 'verified',
          confidenceReason: 'Directly observed: no credential value was entered, and the page still left the login wall.',
        });
        return;
      }

      if (!errorText && responses.length === 0) {
        ctx.onLog('[LoginBoundary] Empty submission blocked client-side with no visible message — likely native browser validation (e.g. required-field tooltip), which this check cannot distinguish from a silent no-op; not flagging without stronger evidence');
        return;
      }

      if (!errorText && responses.some((s) => s >= 200 && s < 300)) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Journey',
          title: 'Empty-credential login submission gives no visible feedback despite a backend round-trip',
          steps: [`Open ${ctx.config.targetUrl}`, 'Leave all login fields blank', 'Click the submit/login button'],
          expected: 'A clear validation message when login fields are submitted blank',
          actual: `The form sent a request that received HTTP ${responses.find((s) => s >= 200 && s < 300)}, but no error or validation message was shown to the user`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: urlBefore,
          confidence: 'heuristic',
          confidenceReason: 'Feedback rendered outside the common error-message selectors (e.g. a subtle inline style change) would not be detected by this check.',
        });
        return;
      }

      ctx.onLog(`[LoginBoundary] Empty-credential submission correctly rejected${errorText ? `: "${errorText.trim().slice(0, 80)}"` : ''}`);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
