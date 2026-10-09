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

  // ── Shift+Tab — focus should move BACKWARD to the previously-visited element ──────────────
  const beforeShiftTab = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(150);
  const afterShiftTab = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
  if (afterShiftTab === beforeShiftTab && interactiveTags.has(beforeShiftTab)) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Accessibility',
      title: 'Shift+Tab does not move focus backward',
      steps: ['Tab forward through several elements', 'Press Shift+Tab'],
      expected: 'Focus should move to the previously-focused element',
      actual: `Focus stayed on the same <${afterShiftTab.toLowerCase()}> element`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Could reflect a custom keydown handler intercepting Shift+Tab for a legitimate reason (e.g. a focus-trapped widget) — verify context before treating as confirmed.',
    });
  } else {
    ctx.onLog('[KeyboardNav] Shift+Tab correctly moves focus backward');
  }

  // Target the common bug: a non-native clickable (`[role="button"]`/`div[onclick]`)
  // that responds to mouse clicks but has no keydown handler for Enter/Space at all.
  const customButton = page.locator('[role="button"]:visible, div[onclick]:visible, span[onclick]:visible').first();
  if ((await customButton.count()) > 0) {
    const tabIndex = await customButton.getAttribute('tabindex');
    const isFocusable = tabIndex !== null && tabIndex !== '-1';
    if (isFocusable) {
      // A real keydown/keyup listener is invisible to introspection from outside without
      // triggering a real click (which could have side effects on an arbitrary page) — logged
      // for manual follow-up rather than asserted, since silence here isn't evidence either way.
      ctx.onLog('[KeyboardNav] Found a custom clickable (role="button"/onclick div) that IS keyboard-focusable — manually verify Enter/Space actually activates it, which this check cannot confirm without risking a real click side effect');
    } else {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Accessibility',
        title: 'Custom clickable element is not keyboard-focusable',
        steps: ['Inspect a [role="button"] or onclick-bearing element with no tabindex'],
        expected: 'An element acting as a button should be focusable (tabindex="0" or a native <button>)',
        actual: 'Element has role="button" or an onclick handler but no tabindex, so it is unreachable via Tab',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'Directly observed: the element has a button-like role/handler but no tabindex attribute making it focusable.',
      });
    }
  }

  // ── Keyboard-only form submission ─────────────────────────────────────────────────────────
  // Tabs to a visible submit control and presses Enter rather than clicking — many forms are
  // wired to a click handler only and silently do nothing on a pure-keyboard submit attempt.
  const submitBtn = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if ((await submitBtn.count()) > 0) {
    try {
      await submitBtn.focus();
      const focusedIsSubmit = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('type') === 'submit';
      });
      if (focusedIsSubmit) {
        const urlBefore = page.url();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        const urlAfter = page.url();
        const formStillPresent = (await page.locator('form').count()) > 0;
        ctx.onLog(`[KeyboardNav] Keyboard-only submit via Enter on the focused submit button: ${urlAfter !== urlBefore ? 'navigated' : formStillPresent ? 'form still present (likely validation or AJAX submit)' : 'page changed'}`);
      } else {
        ctx.onLog('[KeyboardNav] Could not confirm focus landed on the submit control — skipping keyboard-only submit check');
      }
    } catch { /* ignore — avoid failing the whole flow over one optional sub-check */ }
  }

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
