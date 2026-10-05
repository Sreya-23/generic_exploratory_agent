// A12 — Pagination UI: last page, jump pages, refresh mid-scroll
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runPaginationUi(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[PaginationUI] Testing pagination controls');

  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `pagination-${name}.png`);

  // Find pagination controls
  const paginationSelectors = [
    '[aria-label*="pagination" i]',
    '[class*="pagination"]',
    '[class*="pager"]',
    'nav[role="navigation"] a',
    'button:has-text("Next")',
    'a:has-text("Next")',
    '[data-testid*="pagination"]',
  ];

  let paginationFound = false;

  for (const sel of paginationSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      paginationFound = true;
      ctx.onLog(`[PaginationUI] Found pagination via: ${sel}`);
      break;
    }
  }

  // Search/filter result-count consistency, sort, and filter checks don't depend on pagination
  // controls existing (a search-only list with no pager can still lie about its own count), so
  // these run regardless of whether pagination was found above.
  await checkSearchResultCountConsistency(page, ctx);
  await checkSortControl(page, ctx);
  await checkFilterControl(page, ctx);

  if (!paginationFound) {
    ctx.onLog('[PaginationUI] No pagination controls found on this page');
    return;
  }

  // 1. Test "Next" button
  const nextBtn = page
    .locator('button:has-text("Next"), a:has-text("Next"), [aria-label="Next page"]')
    .first();

  if ((await nextBtn.count()) > 0) {
    const urlBefore = page.url();
    await nextBtn.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(600);
    const s1 = shot('next-page');
    await page.screenshot({ path: s1 });
    ctx.onLog(`[PaginationUI] Next clicked — now at: ${page.url()}`);

    // 2. Refresh on page 2 and check state preserved
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const urlAfterRefresh = page.url();
    const s2 = shot('refresh-on-page2');
    await page.screenshot({ path: s2 });

    if (urlAfterRefresh !== page.url()) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Pagination',
        title: 'Refresh on page 2 redirects away from current page',
        steps: ['Navigate to next page', 'Refresh browser'],
        expected: 'Stay on the same paginated page after refresh',
        actual: `Redirected to ${page.url()} instead of ${urlAfterRefresh}`,
        evidence: [s1, s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }

    // 3. Navigate to "Last" page
    const lastBtn = page
      .locator('button:has-text("Last"), a:has-text("Last"), [aria-label="Last page"]')
      .first();

    if ((await lastBtn.count()) > 0) {
      await lastBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(600);
      const s3 = shot('last-page');
      await page.screenshot({ path: s3 });

      // On last page, "Next" should be disabled
      const nextDisabled =
        (await nextBtn.isDisabled().catch(() => false)) ||
        !(await nextBtn.isVisible().catch(() => true));

      if (!nextDisabled) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Pagination',
          title: '"Next" button still enabled on last page',
          steps: ['Navigate to last page', 'Check Next button state'],
          expected: '"Next" disabled or hidden on last page',
          actual: '"Next" button appears enabled on last page',
          evidence: [s3],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        ctx.onLog('[PaginationUI] Next correctly disabled on last page');
      }
    }

    // 4. Go back to first page
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // 5. Check if Previous/Back is disabled on page 1
    const prevBtn = page
      .locator('button:has-text("Prev"), a:has-text("Prev"), button:has-text("Previous"), [aria-label="Previous page"]')
      .first();

    if ((await prevBtn.count()) > 0) {
      const prevDisabled = await prevBtn.isDisabled().catch(() => false);
      if (!prevDisabled) {
        const s4 = shot('prev-on-first-page');
        await page.screenshot({ path: s4 });
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Pagination',
          title: '"Previous" button enabled on first page',
          steps: ['Navigate to first page', 'Check Previous button state'],
          expected: '"Previous" disabled or hidden on first page',
          actual: '"Previous" button appears active on first page',
          evidence: [s4],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }
    }
  }
}

// §9 — Search/filter result-count consistency: a page shouldn't disagree with itself about
// how many results it has (e.g. a "0 results" label while rows are still rendered below it,
// or a declared count with nothing actually rendered). Searching is a SAFE, side-effect-free
// action (free text, no submission of PII) so this needs no gating before it runs.
const RESULT_COUNT_PATTERN = /\b(\d+)\s*(results?|items?|records?|entries|matches)\b/i;
const ROW_SELECTORS = 'table tbody tr, [role="row"], [class*="list-item"], [class*="table-row"]';
const SEARCH_INPUT_SELECTOR =
  'input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i], input[name*="search" i]';
// A query designed to never match real data — the cleanest way to check the "no results"
// state is internally consistent, without needing to know anything about this site's data.
const NO_MATCH_NEEDLE = 'zzznonexistentqueryxyz9912';

async function extractDeclaredResultCount(page: Page): Promise<number | null> {
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const match = text.match(RESULT_COUNT_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

async function checkSearchResultCountConsistency(page: Page, ctx: ExecutorContext): Promise<void> {
  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  if ((await searchInput.count()) === 0) return;
  if (!(await searchInput.isVisible().catch(() => false))) return;

  ctx.onLog('[PaginationUI] Checking search result count consistency');
  const shot = (name: string) => join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `search-count-${name}.png`);
  const originalValue = await searchInput.inputValue().catch(() => '');

  await searchInput.fill(NO_MATCH_NEEDLE).catch(() => {});
  // Debounce settle for typeahead/live-search UIs, then allow for a full navigation-style search.
  await page.waitForTimeout(900);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const declaredCount = await extractDeclaredResultCount(page);
  const renderedRows = await page.locator(ROW_SELECTORS).count().catch(() => 0);

  if (declaredCount === 0 && renderedRows > 0) {
    const shotPath = shot('zero-declared-but-rows-render');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Search',
      title: 'Search declares "0 results" while rows are still rendered',
      steps: [`Type a non-matching search query ("${NO_MATCH_NEEDLE}")`, 'Compare the displayed result count against the actual rendered list'],
      expected: 'Result count label matches the number of rows actually displayed',
      actual: `Page declares 0 results but ${renderedRows} row(s) are still visible in the list/table`,
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else if (declaredCount !== null && declaredCount > 0 && renderedRows === 0) {
    const shotPath = shot('declared-count-but-no-rows');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Search',
      title: 'Search declares results but no matching rows are rendered',
      steps: [`Type a non-matching search query ("${NO_MATCH_NEEDLE}")`, 'Compare the displayed result count against the actual rendered list'],
      expected: 'Result count label matches the number of rows actually displayed',
      actual: `Page declares ${declaredCount} result(s) but 0 rows are visible in the list/table`,
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog(`[PaginationUI] Search count consistent (declared: ${declaredCount ?? 'n/a'}, rendered rows: ${renderedRows})`);
  }

  // Restore original state so later flows/tasks don't inherit a filtered/empty view.
  await searchInput.fill(originalValue).catch(() => {});
  await page.waitForTimeout(400);
}

async function rowOrderFingerprint(page: Page): Promise<string[]> {
  return page
    .locator(ROW_SELECTORS)
    .evaluateAll((rows) => rows.slice(0, 10).map((r) => (r.textContent ?? '').trim().slice(0, 80)))
    .catch(() => [] as string[]);
}

// §9 — Sort control: clicking a sortable column header should visibly reorder the rows.
// Deliberately domain-agnostic — this doesn't know whether ascending or descending is
// "correct" for this data, only whether clicking sort does anything observable at all.
const SORT_HEADER_SELECTOR =
  'th[aria-sort], th button, [role="columnheader"][aria-sort], button[aria-label*="sort" i], [class*="sortable" i]';

async function checkSortControl(page: Page, ctx: ExecutorContext): Promise<void> {
  const sortHeader = page.locator(SORT_HEADER_SELECTOR).first();
  if ((await sortHeader.count().catch(() => 0)) === 0) return;
  if (!(await sortHeader.isVisible().catch(() => false))) return;

  const label = ((await sortHeader.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'column header';
  ctx.onLog(`[PaginationUI] Checking sort control: "${label}"`);

  const before = await rowOrderFingerprint(page);
  if (before.length < 2) {
    ctx.onLog('[PaginationUI] Fewer than 2 rows visible — not enough data to verify sort actually reorders anything');
    return;
  }

  await sortHeader.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const afterFirstClick = await rowOrderFingerprint(page);

  await sortHeader.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const afterSecondClick = await rowOrderFingerprint(page);

  const firstClickChanged = JSON.stringify(before) !== JSON.stringify(afterFirstClick);
  const secondClickChanged = JSON.stringify(afterFirstClick) !== JSON.stringify(afterSecondClick);

  if (!firstClickChanged && !secondClickChanged) {
    const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'sort-no-reorder.png');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Sort',
      title: `Sorting by "${label}" does not visibly reorder rows`,
      steps: [`Click the "${label}" sort control twice`, 'Compare row order before and after each click'],
      expected: 'Clicking a sort control changes the visible row order',
      actual: `Row order was identical before and after clicking "${label}" twice in a row`,
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Compares raw row text order only — a genuinely broken sort control and a data set of near-identical rows that happen to look the same both directions would both trigger this; verify against the underlying data before treating as confirmed.',
    });
  } else {
    ctx.onLog(`[PaginationUI] Sort control "${label}" reorders rows on click`);
  }
}

// §9 — Filter control: selecting a specific (non-default) filter option should visibly change
// the list — either the row count, the row content, or both.
const FILTER_SELECT_SELECTOR =
  'select[name*="filter" i], select[aria-label*="filter" i], select[id*="filter" i], [class*="filter" i] select';

async function checkFilterControl(page: Page, ctx: ExecutorContext): Promise<void> {
  const filterSelect = page.locator(FILTER_SELECT_SELECTOR).first();
  if ((await filterSelect.count().catch(() => 0)) === 0) return;
  if (!(await filterSelect.isVisible().catch(() => false))) return;

  const options = await filterSelect.locator('option').all();
  if (options.length < 2) return;

  const originalValue = await filterSelect.inputValue().catch(() => '');
  // Option 0 is commonly "All"/blank — option 1 is more likely to actually narrow the list.
  const targetValue = await options[1].getAttribute('value').catch(() => null);
  if (targetValue === null || targetValue === originalValue) return;

  ctx.onLog('[PaginationUI] Checking filter control narrows the visible list');
  const before = await page.locator(ROW_SELECTORS).count().catch(() => 0);
  const beforeText = await rowOrderFingerprint(page);

  await filterSelect.selectOption(targetValue).catch(() => {});
  await page.waitForTimeout(700);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const after = await page.locator(ROW_SELECTORS).count().catch(() => 0);
  const afterText = await rowOrderFingerprint(page);
  const changed = before !== after || JSON.stringify(beforeText) !== JSON.stringify(afterText);

  if (!changed && before > 0) {
    const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'filter-no-change.png');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Filter',
      title: 'Selecting a filter option produces no visible change to the list',
      steps: ['Select a non-default filter option', 'Compare the visible list before and after'],
      expected: 'Selecting a specific filter value narrows or otherwise changes the visible list',
      actual: `Row count (${before}) and content were unchanged after selecting a specific filter option`,
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Could genuinely mean the filter is broken, or that this particular option coincidentally matches the entire unfiltered set — verify against the underlying data before treating as confirmed.',
    });
  } else {
    ctx.onLog(`[PaginationUI] Filter control changes the visible list (rows: ${before} → ${after})`);
  }

  // Restore original selection so later flows/tasks don't inherit a filtered view.
  await filterSelect.selectOption(originalValue).catch(() => {});
  await page.waitForTimeout(400);
}
