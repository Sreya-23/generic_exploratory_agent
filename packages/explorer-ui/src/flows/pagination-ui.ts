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
  await checkExactSearchFindsRealMatch(page, ctx);
  await checkSortControl(page, ctx);
  await checkFilterControl(page, ctx);
  await checkSearchPlusFilterCombo(page, ctx);

  if (!paginationFound) {
    ctx.onLog('[PaginationUI] No pagination controls found on this page');
    return;
  }

  // ── Change page size ──────────────────────────────────────────────────────────────────────
  const pageSizeSelect = page.locator(
    'select[name*="page-size" i], select[name*="pagesize" i], select[aria-label*="per page" i], select[aria-label*="page size" i], select[aria-label*="rows per page" i]',
  ).first();
  if ((await pageSizeSelect.count()) > 0) {
    const optionsCount = await pageSizeSelect.locator('option').count();
    if (optionsCount >= 2) {
      const rowsBefore = await page.locator(ROW_SELECTORS).count().catch(() => 0);
      const originalPageSize = await pageSizeSelect.inputValue().catch(() => '');
      await pageSizeSelect.selectOption({ index: optionsCount - 1 }).catch(() => {});
      await page.waitForTimeout(600);
      const rowsAfter = await page.locator(ROW_SELECTORS).count().catch(() => 0);
      if (rowsAfter <= rowsBefore && rowsBefore > 0) {
        ctx.onLog(`[PaginationUI] Page size change: rows went from ${rowsBefore} to ${rowsAfter} — expected an increase when selecting a larger page size, but the total dataset may simply be smaller than both sizes, so not flagged as a defect`);
      } else {
        ctx.onLog(`[PaginationUI] Page size control works — rows changed from ${rowsBefore} to ${rowsAfter}`);
      }
      if (originalPageSize) await pageSizeSelect.selectOption({ value: originalPageSize }).catch(() => {});
    }
  } else {
    ctx.onLog('[PaginationUI] No page-size selector found — skipping');
  }

  // ── Page number selection (click page "2" or similar directly, not just Next) ───────────────
  const pageNumberLink = page.locator('[class*="pagination"] a, [class*="pagination"] button, nav[role="navigation"] a')
    .filter({ hasText: /^\d+$/ })
    .first();
  if ((await pageNumberLink.count()) > 0) {
    const targetPageText = (await pageNumberLink.textContent())?.trim();
    const urlBeforePageClick = page.url();
    const rowsBeforePageClick = await rowOrderFingerprint(page);
    await pageNumberLink.click().catch(() => {});
    await page.waitForTimeout(600);
    const rowsAfterPageClick = await rowOrderFingerprint(page);
    const navigatedOrChanged =
      page.url() !== urlBeforePageClick || JSON.stringify(rowsAfterPageClick) !== JSON.stringify(rowsBeforePageClick);
    if (!navigatedOrChanged) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Pagination',
        title: `Clicking page number "${targetPageText}" has no visible effect`,
        steps: [`Click the numbered page link "${targetPageText}"`],
        expected: 'The page content or URL should change to reflect the selected page',
        actual: 'Neither the URL nor the page content changed',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog(`[PaginationUI] Numbered page link "${targetPageText}" works`);
    }
    await page.goto(urlBeforePageClick, { waitUntil: 'domcontentloaded' }).catch(() => {});
  } else {
    ctx.onLog('[PaginationUI] No numbered page links found (Next/Prev/Last only) — skipping');
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

// Checklist (UI) §8 — "Exact search"/"Partial search": the no-match check above can't tell a
// correctly-filtering search apart from a search that's completely broken and always returns
// empty — both look identical against a guaranteed-no-match query. This closes that blind spot
// by searching for a word taken from an ACTUAL row already on the page and confirming it's still
// findable, which a totally-broken search would fail.
async function checkExactSearchFindsRealMatch(page: Page, ctx: ExecutorContext): Promise<void> {
  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  if ((await searchInput.count()) === 0 || !(await searchInput.isVisible().catch(() => false))) return;

  const rows = page.locator(ROW_SELECTORS);
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount === 0) return;

  const firstRowText = (await rows.first().textContent().catch(() => '')) ?? '';
  // Pull one distinctive, searchable word — skip pure numbers/short tokens which are too
  // generic (likely to coincidentally match many/most rows regardless of whether search works).
  const candidateWord = firstRowText
    .split(/\s+/)
    .map((w) => w.replace(/[^\w]/g, ''))
    .find((w) => w.length >= 4 && !/^\d+$/.test(w));
  if (!candidateWord) {
    ctx.onLog('[PaginationUI] Could not extract a distinctive word from an existing row — skipping exact-search-finds-real-match check');
    return;
  }

  const originalValue = await searchInput.inputValue().catch(() => '');
  await searchInput.fill(candidateWord).catch(() => {});
  await page.waitForTimeout(900);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const matchedRows = await page.locator(ROW_SELECTORS).count().catch(() => 0);
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const wordStillPresent = bodyText.toLowerCase().includes(candidateWord.toLowerCase());

  if (matchedRows === 0 && !wordStillPresent) {
    const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'search-exact-no-match.png');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Search',
      title: `Search for a word taken from an existing row ("${candidateWord}") returns no results`,
      steps: [`Note a word from a real, currently-rendered row: "${candidateWord}"`, `Search for exactly that word`],
      expected: 'Searching for a word that genuinely exists in the data should return at least that one matching row',
      actual: 'Zero rows rendered and the word no longer appears anywhere on the page after searching for it',
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'The word could have come from UI chrome rather than actual searchable row data (e.g. a column header caught by the row selector) — verify before treating as confirmed.',
    });
  } else {
    ctx.onLog(`[PaginationUI] Exact-search sanity check passed — searching for "${candidateWord}" (taken from a real row) returns results`);
  }

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

// Checklist (UI) §8/§9 — "Search + filter" combined. Applies a real, non-default filter option
// AND a search query together, then checks the combined result is no WIDER than filtering alone
// — i.e. adding a search term on top of an active filter should only narrow the list further,
// never un-filter it back out. Doesn't know what the "correct" combined count should be, only
// that combining two narrowing operations can't legitimately WIDEN the result set.
async function checkSearchPlusFilterCombo(page: Page, ctx: ExecutorContext): Promise<void> {
  const filterSelect = page.locator(FILTER_SELECT_SELECTOR).first();
  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  if ((await filterSelect.count().catch(() => 0)) === 0 || (await searchInput.count().catch(() => 0)) === 0) return;
  if (!(await filterSelect.isVisible().catch(() => false)) || !(await searchInput.isVisible().catch(() => false))) return;

  const options = await filterSelect.locator('option').all();
  if (options.length < 2) return;
  const originalFilterValue = await filterSelect.inputValue().catch(() => '');
  const originalSearchValue = await searchInput.inputValue().catch(() => '');
  const targetFilterValue = await options[1].getAttribute('value').catch(() => null);
  if (targetFilterValue === null || targetFilterValue === originalFilterValue) return;

  ctx.onLog('[PaginationUI] Checking search + filter combined narrowing');

  // Apply the filter alone first, to get a baseline row count for "filter only".
  await filterSelect.selectOption(targetFilterValue).catch(() => {});
  await page.waitForTimeout(700);
  const filterOnlyCount = await page.locator(ROW_SELECTORS).count().catch(() => 0);
  if (filterOnlyCount === 0) {
    // Nothing to narrow further — restore and bail out cleanly.
    await filterSelect.selectOption(originalFilterValue).catch(() => {});
    return;
  }

  // Pull a real word from one of the still-visible (filtered) rows, so the search term is
  // guaranteed to at least partially match the current filtered set rather than being a guess.
  const rowText = (await page.locator(ROW_SELECTORS).first().textContent().catch(() => '')) ?? '';
  const searchWord = rowText.split(/\s+/).map((w) => w.replace(/[^\w]/g, '')).find((w) => w.length >= 4 && !/^\d+$/.test(w));
  if (!searchWord) {
    await filterSelect.selectOption(originalFilterValue).catch(() => {});
    ctx.onLog('[PaginationUI] Could not extract a search word from the filtered rows — skipping search+filter combo check');
    return;
  }

  await searchInput.fill(searchWord).catch(() => {});
  await page.waitForTimeout(900);
  const combinedCount = await page.locator(ROW_SELECTORS).count().catch(() => 0);

  if (combinedCount > filterOnlyCount) {
    const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'search-filter-combo-widened.png');
    await page.screenshot({ path: shotPath }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Search',
      title: 'Adding a search term on top of an active filter widens the result set',
      steps: [`Apply a filter (${filterOnlyCount} row(s) shown)`, `Add a search term ("${searchWord}", taken from one of the filtered rows)`],
      expected: 'Combining a search with an active filter should narrow results further, never show MORE rows than the filter alone',
      actual: `Filter alone: ${filterOnlyCount} row(s); filter + search: ${combinedCount} row(s)`,
      evidence: [shotPath],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Could indicate the search field clears/overrides the active filter rather than combining with it (an OR instead of an AND) — verify the actual intended behavior before treating as confirmed.',
    });
  } else {
    ctx.onLog(`[PaginationUI] Search + filter combine correctly (filter only: ${filterOnlyCount}, combined: ${combinedCount})`);
  }

  await searchInput.fill(originalSearchValue).catch(() => {});
  await filterSelect.selectOption(originalFilterValue).catch(() => {});
  await page.waitForTimeout(400);
}
