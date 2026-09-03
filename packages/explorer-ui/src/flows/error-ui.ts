// A9 — Error UI: inline errors, toast duration, error recovery
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage, findVisibleErrorText } from './helpers.js';

export async function runErrorUi(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[ErrorUI] Testing error message visibility, duration, and clarity');

  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `error-ui-${name}.png`);

  const form = page.locator('form').first();
  if ((await form.count()) === 0) {
    ctx.onLog('[ErrorUI] No form found — skipping');
    return;
  }

  const submitBtn = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await submitBtn.count()) === 0) {
    ctx.onLog('[ErrorUI] No submit button — skipping');
    return;
  }

  // Fill with plausible-but-wrong values, not empty ones — an EMPTY submission tests a
  // different thing (required-field validation, which many apps handle separately or not at
  // all) than genuinely WRONG credentials, which is what "invalid credentials" actually means.
  // Confirmed real gap: this previously cleared fields to blank and still reported findings
  // titled "invalid login credentials," which don't match what was actually submitted — a
  // real login page can correctly show nothing for an empty submit (e.g. relying on native
  // required-field validation) while still correctly showing "Invalid credentials" for a
  // filled-but-wrong attempt, and the old wording made the former look like the latter.
  const inputs = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"])');
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const type = await input.getAttribute('type').catch(() => null);
    const value = type === 'password' ? 'WrongPassword_QA123!' : 'invalid_test_user@example.com';
    await input.fill(value).catch(() => {});
  }

  await submitBtn.click().catch(() => {});

  // Filled credentials mean a real server round-trip now (not just client-side validation on
  // empty fields), so this needs more headroom than the old 800ms gave it. Screenshot AFTER
  // the wait, not before, so the evidence actually shows the outcome rather than the
  // pre-response page state.
  const errorText = await findVisibleErrorText(page, 1500);
  const s1 = shot('after-invalid-submit');
  await page.screenshot({ path: s1 });

  if (!errorText) {
    // Final check: native :invalid pseudo-class (browser built-in validation)
    const hasNativeInvalid = await page.evaluate(() =>
      document.querySelectorAll('input:invalid, select:invalid').length > 0,
    );

    if (!hasNativeInvalid) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-ErrorUI',
        title: 'No visible error message after invalid form submission',
        steps: [
          'Fill all form fields with plausible-but-invalid values (wrong password, bogus email)',
          'Click Submit',
          'Wait 1500ms for a server round-trip',
        ],
        expected: 'Clear, descriptive error message shown',
        actual: 'No error message with text visible after 1500ms (empty containers excluded)',
        evidence: [s1],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[ErrorUI] Native browser :invalid validation is active — OK');
    }
    return;
  }

  ctx.onLog(`[ErrorUI] Error message visible: "${errorText.slice(0, 100)}"`);

  // Toast duration check — error should stay visible for at least 8s
  await page.waitForTimeout(8000);
  const s2 = shot('error-after-8s');
  await page.screenshot({ path: s2 });

  const errorTextAfter8s = await findVisibleErrorText(page, 0);
  if (!errorTextAfter8s) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ErrorUI',
      title: 'Validation error auto-dismissed before user could correct the form',
      steps: ['Submit empty form', 'Observe error message', 'Wait 8 seconds'],
      expected: 'Error stays until user fixes the field or interacts',
      actual: `Error "${errorText.slice(0, 60)}" disappeared within 8 seconds`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog('[ErrorUI] Error persists after 8s — correct behaviour');
  }

  // Check if error clears after filling the field
  const firstInput = inputs.first();
  if ((await firstInput.count()) > 0) {
    await firstInput.fill('test_recovery_value');
    await page.waitForTimeout(400);
    const errorAfterFix = await findVisibleErrorText(page, 0);
    if (errorAfterFix) {
      ctx.onLog('[ErrorUI] Error persists after field correction — may need user to resubmit');
    } else {
      ctx.onLog('[ErrorUI] Error clears after field correction — good UX');
    }
  }
}
