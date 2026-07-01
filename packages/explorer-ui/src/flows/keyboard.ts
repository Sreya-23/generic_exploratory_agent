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
  if (count === 0) {
    ctx.onLog('[KeyboardNav] No focusable elements found — skipping');
    return;
  }

  // Headless browsers require a click into the document before Tab moves focus.
  // Without this, focus stays on <body> even on a page with many focusable elements,
  // producing a false-positive. Clicking the body simulates what a real user does
  // (clicks onto the page) before starting keyboard navigation.
  await page.click('body', { position: { x: 0, y: 0 } }).catch(() => {});
  await page.waitForTimeout(100);

  // Press Tab and wait for focus to settle
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);

  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
  const activeRole = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? '');
  const activeType = await page.evaluate(() =>
    (document.activeElement as HTMLInputElement)?.type ?? '',
  );

  ctx.onLog(`[KeyboardNav] After Tab: focused element = ${activeTag}${activeType ? `[type="${activeType}"]` : ''}${activeRole ? `[role="${activeRole}"]` : ''}`);

  const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

  if (activeTag === 'BODY' || (!interactiveTags.has(activeTag) && !activeRole)) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Accessibility',
      title: 'Tab key does not move focus to first interactive element',
      steps: ['Click body to set document focus', 'Press Tab once', 'Check document.activeElement'],
      expected: 'Focus moves to first button, link, or input',
      actual: `Focus stayed on <${activeTag.toLowerCase()}> — interactive elements may not be in the tab order`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  // Tab through up to 5 more elements and check for focus traps
  const visited = new Set<string>([activeTag]);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const nextTag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
    if (nextTag === 'BODY') {
      // Focus wrapped back to body — could indicate a focus trap exiting issue
      ctx.onLog(`[KeyboardNav] Focus returned to BODY after ${i + 2} Tabs`);
      break;
    }
    visited.add(nextTag);
  }

  ctx.onLog(`[KeyboardNav] Keyboard navigation OK — visited: ${[...visited].join(', ')}`);

  // Test Escape key on modals/dialogs
  const hasModal = (await page.locator('[role="dialog"], [role="alertdialog"]').count()) > 0;
  if (hasModal) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const modalStillVisible =
      (await page.locator('[role="dialog"]:visible').count()) > 0;
    if (modalStillVisible) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Accessibility',
        title: 'Escape key does not close open modal/dialog',
        steps: ['Open modal', 'Press Escape'],
        expected: 'Modal closes on Escape (WCAG 2.1 criterion 2.1.2)',
        actual: 'Modal remains visible after Escape key',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
  }
}
