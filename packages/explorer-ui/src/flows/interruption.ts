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
