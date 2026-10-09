import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

const ROW_SELECTOR = 'table tbody tr, [role="row"]';

/**
 * Checklist (UI) §7 — Tables & Lists: row selection, select-all/deselect-all, expand/collapse,
 * and duplicate-record detection. Previously zero coverage — generic-crud.ts/pagination-ui.ts
 * give the impression tables are well-handled (and they are, for CRUD lifecycle and pagination/
 * sort/filter), but selection and row-expansion are a genuinely separate, untested surface.
 */
export async function runTableInteractionCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[Tables] Login wall detected — skipping');
    return;
  }

  const rows = page.locator(ROW_SELECTOR);
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount < 2) {
    ctx.onLog('[Tables] Fewer than 2 rows found — nothing meaningful to check');
    return;
  }

  // ── Row selection + select-all/deselect-all ──────────────────────────────────────────────
  const selectAllCheckbox = page.locator(
    'thead input[type="checkbox"], [role="columnheader"] input[type="checkbox"], [class*="select-all" i] input[type="checkbox"]',
  ).first();
  const rowCheckboxes = rows.locator('input[type="checkbox"]');
  const rowCheckboxCount = await rowCheckboxes.count().catch(() => 0);

  if ((await selectAllCheckbox.count()) > 0 && rowCheckboxCount > 0) {
    // Select all
    await selectAllCheckbox.check({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    const checkedAfterSelectAll = await rowCheckboxes.evaluateAll(
      (els) => els.filter((el) => (el as HTMLInputElement).checked).length,
    ).catch(() => 0);
    if (checkedAfterSelectAll < rowCheckboxCount) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Tables',
        title: '"Select all" does not select every visible row',
        steps: ['Click the header "select all" checkbox'],
        expected: 'Every row checkbox should become checked',
        actual: `${checkedAfterSelectAll} of ${rowCheckboxCount} row checkboxes are checked after selecting all`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'Directly counted checked checkboxes in the live DOM after the select-all action.',
      });
    } else {
      ctx.onLog('[Tables] "Select all" correctly checks every visible row');
    }

    // Deselect all
    await selectAllCheckbox.uncheck({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    const checkedAfterDeselectAll = await rowCheckboxes.evaluateAll(
      (els) => els.filter((el) => (el as HTMLInputElement).checked).length,
    ).catch(() => 0);
    if (checkedAfterDeselectAll > 0) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Tables',
        title: '"Select all" checkbox does not deselect rows when unchecked',
        steps: ['Select all rows via the header checkbox', 'Uncheck the header checkbox'],
        expected: 'Every row checkbox should become unchecked',
        actual: `${checkedAfterDeselectAll} of ${rowCheckboxCount} row checkboxes remain checked`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'Directly counted checked checkboxes in the live DOM after the deselect-all action.',
      });
    } else {
      ctx.onLog('[Tables] Deselect-all correctly clears every row checkbox');
    }
  } else if (rowCheckboxCount > 0) {
    // Individual row selection only, no select-all control found.
    const firstCheckbox = rowCheckboxes.first();
    await firstCheckbox.check({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
    const isChecked = await firstCheckbox.isChecked().catch(() => false);
    if (!isChecked) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Tables',
        title: 'Row checkbox does not toggle when clicked',
        steps: ['Click the first row\'s checkbox'],
        expected: 'The checkbox should become checked',
        actual: 'Checkbox state did not change',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[Tables] Individual row selection works');
    }
    await firstCheckbox.uncheck({ force: true }).catch(() => {});
  } else {
    ctx.onLog('[Tables] No row selection checkboxes found — skipping selection checks');
  }

  // ── Expand/collapse rows ──────────────────────────────────────────────────────────────────
  const expandToggle = rows.locator('[aria-expanded], [class*="expand" i], [class*="chevron" i], [class*="collapse" i]').first();
  if ((await expandToggle.count()) > 0 && (await expandToggle.isVisible().catch(() => false))) {
    const beforeExpanded = await expandToggle.getAttribute('aria-expanded');
    await expandToggle.click().catch(() => {});
    await page.waitForTimeout(300);
    const afterExpanded = await expandToggle.getAttribute('aria-expanded');
    if (beforeExpanded !== null && beforeExpanded === afterExpanded) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Tables',
        title: 'Row expand/collapse toggle does not change aria-expanded state',
        steps: ['Click a row\'s expand/collapse control'],
        expected: 'aria-expanded should toggle between true/false',
        actual: `aria-expanded remained "${afterExpanded}" after clicking`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'The control may expand/collapse visually via a different mechanism than aria-expanded — verify before treating as confirmed.',
      });
    } else {
      ctx.onLog('[Tables] Row expand/collapse control works (or no aria-expanded attribute to compare — inconclusive either way)');
    }
    // Click again to restore original state.
    await expandToggle.click().catch(() => {});
  } else {
    ctx.onLog('[Tables] No row expand/collapse control found — skipping');
  }

  // ── Duplicate record detection ────────────────────────────────────────────────────────────
  const rowTexts = await rows.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).innerText?.trim().replace(/\s+/g, ' ').slice(0, 200) ?? ''),
  ).catch(() => [] as string[]);
  const nonEmpty = rowTexts.filter((t) => t.length > 10); // skip near-empty rows (header spacers etc.)
  const seen = new Map<string, number>();
  for (const t of nonEmpty) seen.set(t, (seen.get(t) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Tables',
      title: 'Duplicate rows rendered in the same list',
      steps: ['Inspect the currently-rendered table/list rows for identical content'],
      expected: 'Each row should represent a distinct record',
      actual: `${duplicates.length} row content pattern(s) appear more than once: ${duplicates.slice(0, 3).map(([t, n]) => `"${t.slice(0, 40)}" ×${n}`).join('; ')}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Two genuinely different records could coincidentally share identical visible text (e.g. two same-named items with different hidden IDs) — verify before treating as confirmed.',
    });
  } else {
    ctx.onLog('[Tables] No duplicate rows detected in the currently-rendered list');
  }
}
