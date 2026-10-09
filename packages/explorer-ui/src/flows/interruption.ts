import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runBackDuringAction(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();

  if ((await submit.count()) === 0) {
    ctx.onLog('[Interruption] No form submit to test');
    return;
  }

  const urlBefore = page.url();

  if (task.flowClass === 'refresh-during-request') {
    await Promise.all([
      submit.click().catch(() => {}),
      page.waitForTimeout(100).then(() => page.reload().catch(() => {})),
    ]);
    await page.waitForTimeout(1000);

    ctx.onFinding({
      severity: 'info',
      area: 'UI-Interruption',
      title: 'Refresh during form submit — verify no duplicate side effects',
      steps: ['Fill form', 'Click submit', 'Immediately refresh page'],
      expected: 'Graceful handling, no duplicate submission',
      actual: `Page reloaded from ${urlBefore} to ${page.url()} — manual verification recommended`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  await submit.click().catch(() => {});
  await page.waitForTimeout(150);
  await page.goBack().catch(() => {});
  await page.waitForTimeout(500);

  const urlAfter = page.url();
  ctx.onLog(`[Interruption] Back during submit: ${urlBefore} → ${urlAfter}`);

  ctx.onFinding({
    severity: 'medium',
    area: 'UI-Chaos',
    title: 'Browser back pressed during form submission',
    steps: ['Fill and submit form', 'Press browser back within 150ms'],
    expected: 'Clear state recovery or warning about incomplete action',
    actual: `Navigated to ${urlAfter} — verify no orphaned or duplicate server state`,
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

/**
 * Checklist (UI) §11/§28 — "Cancel during loading." Same observational posture as the existing
 * checks above (info/medium severity, "manual verification recommended") — what the CORRECT
 * outcome should be after canceling an in-flight request varies too much by app (should it abort
 * the network request? Just hide the UI? Both?) to assert pass/fail generically; the value here
 * is surfacing that the sequence happened at all, with evidence, for a human to judge.
 */
export async function runCancelDuringLoading(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if ((await submit.count()) === 0) {
    ctx.onLog('[Interruption] No form submit to test — skipping cancel-during-loading');
    return;
  }

  await submit.click().catch(() => {});
  await page.waitForTimeout(100);

  const cancelControl = page.locator(
    'button:has-text("Cancel"), button:has-text("Abort"), button:has-text("Stop"), [aria-label*="cancel" i]:visible',
  ).first();
  if ((await cancelControl.count()) === 0 || !(await cancelControl.isVisible().catch(() => false))) {
    ctx.onLog('[Interruption] No visible Cancel/Abort control appeared during the in-flight request — skipping');
    return;
  }

  await cancelControl.click().catch(() => {});
  await page.waitForTimeout(500);

  const stillLoading = await page.locator('[class*="spinner" i]:visible, [class*="loading" i]:visible, [aria-busy="true"]').count().catch(() => 0);
  ctx.onFinding({
    severity: 'info',
    area: 'UI-Interruption',
    title: 'Clicked Cancel while a form submission was in flight',
    steps: ['Submit a form', 'Immediately click the Cancel/Abort control that appeared'],
    expected: 'The operation should stop cleanly with no lingering loading state and no side effect from the canceled request',
    actual: stillLoading > 0
      ? `A loading indicator is still visible ${500}ms after clicking Cancel — verify the request was actually aborted`
      : 'No loading indicator remains after Cancel — verify manually that no side effect from the canceled request was applied',
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

/**
 * Checklist (UI) §11/§28 — "Navigate away during loading" — distinct from back-during-post
 * above (browser Back specifically): this navigates to a DIFFERENT page entirely while a
 * submission is in flight, then returns to check for a stuck loading state or duplicate data
 * left behind. Same observational posture as the rest of this file.
 */
export async function runNavigateAwayDuringLoading(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if ((await submit.count()) === 0) {
    ctx.onLog('[Interruption] No form submit to test — skipping navigate-away-during-loading');
    return;
  }

  const urlBefore = page.url();
  const homeUrl = new URL('/', urlBefore).toString();

  await submit.click().catch(() => {});
  await page.waitForTimeout(100);
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Return to the original page to check for a stuck loading indicator left over from the
  // interrupted request, or any other visible sign of an orphaned in-flight operation.
  await page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const stuckLoading = await page.locator('[class*="spinner" i]:visible, [aria-busy="true"]').count().catch(() => 0);

  ctx.onFinding({
    severity: stuckLoading > 0 ? 'medium' : 'info',
    area: 'UI-Interruption',
    title: 'Navigated to a different page while a form submission was in flight',
    steps: ['Submit a form', 'Immediately navigate to a different page', 'Return to the original page'],
    expected: 'Navigating away should cleanly abandon the request, with no stuck loading state on return',
    actual: stuckLoading > 0
      ? 'A loading indicator is still showing on return to the original page — likely a stuck/orphaned state'
      : 'No stuck loading state found on return — verify manually that the interrupted request had no unintended side effect',
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
  });
}
