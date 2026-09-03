import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const DIALOG_SELECTOR = '[role="dialog"], .modal, [aria-modal="true"]';

export async function runFocusTrapCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[FocusTrap] Looking for a modal to check keyboard focus trapping');

  const triggers = page.locator(
    'button:has-text("Open"), button:has-text("Modal"), [data-toggle="modal"], [aria-haspopup="dialog"]',
  );
  if ((await triggers.count().catch(() => 0)) === 0) {
    ctx.onLog('[FocusTrap] No modal triggers found — skipping');
    return;
  }

  await triggers.first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(500);

  const dialog = page.locator(DIALOG_SELECTOR).first();
  if ((await dialog.count().catch(() => 0)) === 0 || !(await dialog.isVisible().catch(() => false))) {
    ctx.onLog('[FocusTrap] Trigger did not open a visible dialog — skipping');
    return;
  }

  ctx.onLog('[FocusTrap] Modal open — tabbing to check focus stays trapped inside it');
  let escaped = false;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab').catch(() => {});
    const insideDialog = await page
      .evaluate((sel) => {
        const dlg = document.querySelector(sel);
        return dlg ? dlg.contains(document.activeElement) : true;
      }, DIALOG_SELECTOR)
      .catch(() => true);
    if (!insideDialog) {
      escaped = true;
      break;
    }
  }

  if (escaped) {
    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'focus-trap.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'A11y-FocusTrap',
      title: 'Keyboard focus escapes an open modal',
      steps: ['Open the modal dialog', 'Press Tab repeatedly'],
      expected: 'Focus stays trapped within the modal until it is closed',
      actual: 'Tab moved keyboard focus to an element outside the modal, behind it',
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
    });
  } else {
    ctx.onLog('[FocusTrap] Focus stayed correctly trapped within the modal');
  }

  await page.keyboard.press('Escape').catch(() => {});
}
