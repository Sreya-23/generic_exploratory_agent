import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runKeyboardNav(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const focusable = page.locator(
    'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  const count = await focusable.count();
  if (count === 0) return;

  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);

  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? 'none');

  if (activeTag === 'BODY' || activeTag === 'none') {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Accessibility',
      title: 'Tab key does not focus interactive elements',
      steps: ['Load page', 'Press Tab'],
      expected: 'Focus moves to first interactive element',
      actual: `Focus remained on ${activeTag}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}
