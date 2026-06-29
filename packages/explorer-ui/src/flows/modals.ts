import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runModalLifecycle(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const triggers = page.locator(
    'button:has-text("Open"), button:has-text("Modal"), [data-toggle="modal"], [aria-haspopup="dialog"]',
  );
  const count = await triggers.count();
  if (count === 0) {
    ctx.onLog('[Modals] No modal triggers found');
    return;
  }

  await triggers.first().click().catch(() => {});
  await page.waitForTimeout(500);

  const dialog = page.locator('[role="dialog"], .modal, [aria-modal="true"]');
  if ((await dialog.count()) === 0) return;

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  if ((await dialog.count()) > 0 && (await dialog.first().isVisible())) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Modals',
      title: 'Modal does not close on Escape key',
      steps: ['Open modal', 'Press Escape'],
      expected: 'Modal closes',
      actual: 'Modal remains visible',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}
