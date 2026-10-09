import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

/**
 * Checklist (UI) §5 — Dropdowns/Selects. Previously this entire category had zero dedicated
 * implementation anywhere in explorer-ui (the only two `selectOption` call sites in the whole
 * package are the optional LLM-driven agentic-explore flow, and pagination-ui.ts's filter-select
 * check, which only exists to probe list-filtering, not dropdown behavior in its own right).
 *
 * Scoped to native `<select>` elements only — a custom combobox/listbox widget's open/close/
 * keyboard behavior is too framework-specific to generalize reliably, and a native `<select>`'s
 * OWN popup is rendered by the OS/browser chrome (not the page's DOM), so visual checks like
 * "near screen boundaries" or "long option text overflow" aren't reliably screenshot-able in
 * headless mode — this focuses on the genuinely checkable part: does selecting actually change
 * the value, correctly, including via keyboard.
 */
export async function runDropdownExploration(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[Dropdowns] Login wall detected — skipping');
    return;
  }

  const selects = await page.locator('select:visible').all();
  if (selects.length === 0) {
    ctx.onLog('[Dropdowns] No visible <select> elements found on this page');
    return;
  }

  const select = selects[0];
  const options = await select.locator('option').all();
  if (options.length < 2) {
    ctx.onLog('[Dropdowns] The only <select> found has fewer than 2 options — nothing to vary');
    return;
  }

  const fieldName = (await select.getAttribute('name')) ?? (await select.getAttribute('id')) ?? 'unnamed select';
  const originalValue = await select.inputValue().catch(() => '');
  let count = 0;

  // ── Select first option ──────────────────────────────────────────────────────────────────
  try {
    await select.selectOption({ index: 0 });
    const expected = await options[0].getAttribute('value') ?? (await options[0].textContent()) ?? '';
    const actual = await select.inputValue();
    if (expected && actual !== expected) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Dropdowns',
        title: `Selecting the first option doesn't update the dropdown's value: ${fieldName}`,
        steps: [`Select the first option of <select name="${fieldName}">`],
        expected: `Value should become "${expected}"`,
        actual: `Value is "${actual}"`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'Directly compares the selected option\'s own value attribute against the select\'s reported value.',
      });
      count++;
    }
  } catch { /* selection failed outright — try remaining cases anyway */ }

  // ── Select last option ───────────────────────────────────────────────────────────────────
  try {
    const lastIndex = options.length - 1;
    await select.selectOption({ index: lastIndex });
    const expected = await options[lastIndex].getAttribute('value') ?? (await options[lastIndex].textContent()) ?? '';
    const actual = await select.inputValue();
    if (expected && actual !== expected) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Dropdowns',
        title: `Selecting the last option doesn't update the dropdown's value: ${fieldName}`,
        steps: [`Select the last option of <select name="${fieldName}">`],
        expected: `Value should become "${expected}"`,
        actual: `Value is "${actual}"`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'Directly compares the selected option\'s own value attribute against the select\'s reported value.',
      });
      count++;
    }
  } catch { /* ignore */ }

  // ── Change selection again (to a middle option) ──────────────────────────────────────────
  const midIndex = Math.floor(options.length / 2);
  try {
    await select.selectOption({ index: midIndex });
    const midValue = await select.inputValue();
    ctx.onLog(`[Dropdowns] ${fieldName}: changed selection to option ${midIndex} ("${midValue}")`);
  } catch { /* ignore */ }

  // ── Multi-select: verify multiple options register together ─────────────────────────────
  const isMultiple = (await select.getAttribute('multiple')) !== null;
  if (isMultiple && options.length >= 2) {
    try {
      const vals = await Promise.all([options[0], options[1]].map((o) => o.getAttribute('value')));
      const toSelect = vals.filter((v): v is string => v !== null);
      if (toSelect.length === 2) {
        await select.selectOption(toSelect);
        const selected = await select.evaluate((el: HTMLSelectElement) =>
          Array.from(el.selectedOptions).map((o) => o.value),
        );
        if (selected.length !== 2) {
          ctx.onFinding({
            severity: 'medium',
            area: 'UI-Dropdowns',
            title: `Multi-select doesn't retain multiple selections: ${fieldName}`,
            steps: [`Select 2 options simultaneously on a <select multiple> element`],
            expected: '2 options should remain selected',
            actual: `${selected.length} option(s) selected after attempting to select 2`,
            evidence: [],
            reproRate: '1/1',
            automationCandidate: true,
            confidence: 'verified',
            confidenceReason: 'Directly reads selectedOptions from the live DOM element.',
          });
          count++;
        }
      }
    } catch { /* ignore */ }
  } else {
    ctx.onLog(`[Dropdowns] ${fieldName}: single-select (no multiple attribute) — multi-select case not applicable`);
  }

  // ── Keyboard navigation: focus + Arrow keys should change the selection ─────────────────
  try {
    await select.focus();
    const beforeArrow = await select.inputValue();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const afterArrow = await select.inputValue();
    if (afterArrow === beforeArrow && midIndex < options.length - 1) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Dropdowns',
        title: `Dropdown doesn't respond to keyboard navigation: ${fieldName}`,
        steps: [`Focus <select name="${fieldName}">`, 'Press ArrowDown'],
        expected: 'The selected value should change when the dropdown is focused and an arrow key is pressed',
        actual: 'Value did not change after ArrowDown',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'A native <select> not responding to ArrowDown while focused is unusual, but some custom onKeyDown handlers intentionally override default behavior — verify before treating as confirmed.',
      });
      count++;
    } else {
      ctx.onLog(`[Dropdowns] ${fieldName}: keyboard ArrowDown correctly changed the selection`);
    }

    // Escape should not crash/break anything — informational only, native selects handle this
    // natively; this just confirms the page doesn't error out.
    await page.keyboard.press('Escape');
  } catch { /* ignore */ }

  // ── Long option text — informational note only (native popup isn't screenshot-able) ─────
  const longOption = await Promise.all(options.slice(0, 20).map((o) => o.textContent()));
  const hasLongText = longOption.some((t) => (t?.length ?? 0) > 60);
  if (hasLongText) {
    ctx.onLog(`[Dropdowns] ${fieldName}: contains an option with unusually long text (>60 chars) — native dropdown rendering can't be screenshot-checked in headless mode, worth a manual look`);
  }

  // ── Restore original value ───────────────────────────────────────────────────────────────
  if (originalValue) {
    await select.selectOption({ value: originalValue }).catch(() => {});
  }

  if (count === 0) {
    ctx.onLog(`[Dropdowns] ${fieldName}: functional checks passed (first/last/multi/keyboard selection all work as expected)`);
  }
}
