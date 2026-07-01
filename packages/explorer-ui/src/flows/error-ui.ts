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

  // Clear all text inputs and submit
  const inputs = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"])');
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    await inputs.nth(i).fill('').catch(() => {});
  }

  await submitBtn.click().catch(() => {});

  const s1 = shot('after-empty-submit');
  await page.screenshot({ path: s1 });

  // Use the shared helper which waits 800ms and searches ordered, specific-first selectors
  // to avoid empty placeholder containers (e.g. Sauce Demo's always-present error div).
  const errorText = await findVisibleErrorText(page, 800);

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
        steps: ['Clear all form fields', 'Click Submit', 'Wait 800ms'],
        expected: 'Clear, descriptive error message shown',
        actual: 'No error message with text visible after 800ms (empty containers excluded)',
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
