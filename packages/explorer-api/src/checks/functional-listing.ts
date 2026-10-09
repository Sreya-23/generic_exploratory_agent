import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Checklist §20/§21 — functional pagination and search correctness, as distinct from
 * boundary.ts's testPagination (which only checks invalid/edge-case params like page=-1 don't
 * crash the server). This checks that VALID pagination/search actually behaves correctly —
 * different pages return different records, and a declared result count matches what's
 * actually returned — entirely via GET, zero write risk.
 */

/** Finds the array of list items in a response body, checking the common shapes (bare array,
 *  or wrapped under data/items/results) rather than assuming one fixed schema. */
function extractListAndCount(body: string): { items: unknown[]; declaredTotal: number | null } | null {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return { items: parsed, declaredTotal: null };
    if (parsed && typeof parsed === 'object') {
      for (const key of ['data', 'items', 'results', 'records']) {
        const list = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(list)) {
          const totalKey = ['total', 'totalCount', 'count', 'totalItems'].find(
            (k) => typeof (parsed as Record<string, unknown>)[k] === 'number',
          );
          const declaredTotal = totalKey ? ((parsed as Record<string, unknown>)[totalKey] as number) : null;
          return { items: list, declaredTotal };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function itemIds(items: unknown[]): string[] {
  return items
    .map((it) => {
      if (it && typeof it === 'object') {
        const obj = it as Record<string, unknown>;
        const id = obj.id ?? obj._id;
        if (id !== undefined) return String(id);
      }
      return JSON.stringify(it).slice(0, 100); // fallback: structural identity
    })
    .filter(Boolean);
}

export async function testFunctionalListing(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/products', '/api/orders']).slice(0, 3);
  if (targets.length === 0) {
    ctx.onLog('[FunctionalListing] No discovered/plausible list endpoint to test — skipping');
    return 0;
  }

  let count = 0;

  for (const path of targets) {
    // ── Pagination: do different pages actually return different records? ──────────────
    let page1, page2;
    try {
      page1 = await probe(baseUrl, { method: 'GET', path: `${path}?page=1&limit=5` }, headers);
      page2 = await probe(baseUrl, { method: 'GET', path: `${path}?page=2&limit=5` }, headers);
    } catch {
      continue;
    }
    if (page1.status !== 200 || page2.status !== 200) continue;

    const list1 = extractListAndCount(page1.body);
    const list2 = extractListAndCount(page2.body);
    if (list1 && list2 && list1.items.length >= 3 && list2.items.length >= 1) {
      const ids1 = itemIds(list1.items);
      const ids2 = itemIds(list2.items);
      const overlap = ids2.filter((id) => ids1.includes(id));
      if (overlap.length === ids2.length) {
        ctx.onFinding({
          severity: 'medium',
          area: 'API-Pagination',
          title: `Page 2 returns the same records as page 1: ${path}`,
          steps: [`GET ${path}?page=1&limit=5`, `GET ${path}?page=2&limit=5`, 'Compare the record IDs returned'],
          expected: 'Requesting a different page should return different records',
          actual: `All ${ids2.length} record(s) on page 2 are identical to records already seen on page 1 — the page parameter may not be honored`,
          evidence: writeApiEvidence(ctx, 'pagination-same', formatEvidence('GET', `${path}?page=2&limit=5`, page2.status, { responseBody: page2.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'heuristic',
          confidenceReason: 'Could also mean the collection genuinely has fewer than 6 total records — verify the collection size before treating as confirmed.',
        });
        count++;
      }

      // ── Declared total vs. actual array length on an UNFILTERED request ──────────────
      if (list1.declaredTotal !== null && list1.declaredTotal < list1.items.length) {
        ctx.onFinding({
          severity: 'medium',
          area: 'API-Pagination',
          title: `Declared total count is smaller than the actual item count: ${path}`,
          steps: [`GET ${path}?page=1&limit=5`, 'Compare the declared total/count field against the actual items array length'],
          expected: 'A declared total/count should be >= the number of items actually returned on a page',
          actual: `Declared total: ${list1.declaredTotal}, actual items returned: ${list1.items.length}`,
          evidence: writeApiEvidence(ctx, 'pagination-count', formatEvidence('GET', `${path}?page=1&limit=5`, page1.status, { responseBody: page1.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'verified',
          confidenceReason: 'Directly compares two numbers from the same response — an objective inconsistency, not inferred.',
        });
        count++;
      }
    }

    // ── Search: a guaranteed-no-match term should return zero results, consistently ──────
    let searchRes;
    try {
      searchRes = await probe(baseUrl, { method: 'GET', path: `${path}?search=zzznonexistentqueryxyz9912&q=zzznonexistentqueryxyz9912` }, headers);
    } catch {
      continue;
    }
    if (searchRes.status !== 200) continue;
    const searchList = extractListAndCount(searchRes.body);
    if (searchList) {
      if (searchList.declaredTotal === 0 && searchList.items.length > 0) {
        ctx.onFinding({
          severity: 'medium',
          area: 'API-Search',
          title: `Search declares 0 results while still returning items: ${path}`,
          steps: [`GET ${path}?search=<a term guaranteed not to match anything>`, 'Compare the declared total against the actual items returned'],
          expected: 'A declared total of 0 should mean 0 items are actually returned',
          actual: `Declared total: 0, actual items returned: ${searchList.items.length}`,
          evidence: writeApiEvidence(ctx, 'search-count', formatEvidence('GET', `${path}?search=zzznonexistentqueryxyz9912`, searchRes.status, { responseBody: searchRes.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'verified',
          confidenceReason: 'Directly compares two fields from the same response.',
        });
        count++;
      } else if (searchList.declaredTotal !== null && searchList.declaredTotal > 0 && searchList.items.length === 0) {
        ctx.onFinding({
          severity: 'low',
          area: 'API-Search',
          title: `Search declares results but returns none: ${path}`,
          steps: [`GET ${path}?search=<a term guaranteed not to match anything>`],
          expected: 'A declared non-zero total should mean at least that many items are returned',
          actual: `Declared total: ${searchList.declaredTotal}, actual items returned: 0`,
          evidence: writeApiEvidence(ctx, 'search-empty', formatEvidence('GET', `${path}?search=zzznonexistentqueryxyz9912`, searchRes.status, { responseBody: searchRes.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'heuristic',
          confidenceReason: 'The declared total may reflect an unfiltered count by design on this endpoint — verify the field is actually meant to reflect the filtered result before treating as confirmed.',
        });
        count++;
      } else if (searchList.items.length === 0) {
        ctx.onLog(`[FunctionalListing] ${path}: search for a non-matching term correctly returns 0 items`);
      }
    }

    // ── Sort: a sort param should actually change the order, and order correctly ────────────
    if (list1 && list1.items.length >= 3) {
      const sortField = ['name', 'title', 'price', 'createdAt', 'date'].find((f) =>
        list1.items.every((it) => it && typeof it === 'object' && (it as Record<string, unknown>)[f] !== undefined),
      );
      if (sortField) {
        let sortedRes;
        try {
          sortedRes = await probe(baseUrl, { method: 'GET', path: `${path}?sort=${sortField}&order=asc` }, headers);
        } catch {
          sortedRes = null;
        }
        if (sortedRes && sortedRes.status === 200) {
          const sortedList = extractListAndCount(sortedRes.body);
          if (sortedList && sortedList.items.length >= 3) {
            const values = sortedList.items.map((it) => (it as Record<string, unknown>)[sortField]);
            const isSorted = values.every((v, i) => i === 0 || String(v ?? '') >= String(values[i - 1] ?? ''));
            const sameAsUnsorted = JSON.stringify(values) === JSON.stringify(list1.items.map((it) => (it as Record<string, unknown>)[sortField]));
            if (!isSorted && !sameAsUnsorted) {
              ctx.onFinding({
                severity: 'medium',
                area: 'API-Sort',
                title: `sort=${sortField} does not actually order results: ${path}`,
                steps: [`GET ${path}?sort=${sortField}&order=asc`, `Compare the "${sortField}" values across returned items`],
                expected: `Items should be ordered ascending by "${sortField}"`,
                actual: `Returned order is neither ascending by "${sortField}" nor unchanged from the default order — sort param appears to be accepted but ignored`,
                evidence: writeApiEvidence(ctx, 'sort-incorrect', formatEvidence('GET', `${path}?sort=${sortField}&order=asc`, sortedRes.status, { responseBody: sortedRes.body })),
                reproRate: '1/1',
                automationCandidate: true,
                pageUrl: path,
                confidence: 'heuristic',
                confidenceReason: 'Field-name guessing (sort/order query param convention) may not match this API\'s actual sort syntax — verify the param name is correct before treating as confirmed.',
              });
              count++;
            }
          }
        }
      }
    }

    // ── Filter: filtering by a real observed value should only return matching items ───────
    if (list1 && list1.items.length >= 2) {
      const filterField = ['status', 'category', 'type'].find((f) =>
        list1.items[0] && typeof list1.items[0] === 'object' && typeof (list1.items[0] as Record<string, unknown>)[f] === 'string',
      );
      if (filterField) {
        const filterValue = String((list1.items[0] as Record<string, unknown>)[filterField]);
        let filteredRes;
        try {
          filteredRes = await probe(baseUrl, { method: 'GET', path: `${path}?${filterField}=${encodeURIComponent(filterValue)}` }, headers);
        } catch {
          filteredRes = null;
        }
        if (filteredRes && filteredRes.status === 200) {
          const filteredList = extractListAndCount(filteredRes.body);
          if (filteredList && filteredList.items.length > 0) {
            const mismatched = filteredList.items.filter(
              (it) => it && typeof it === 'object' && String((it as Record<string, unknown>)[filterField] ?? '') !== filterValue,
            );
            if (mismatched.length > 0) {
              ctx.onFinding({
                severity: 'medium',
                area: 'API-Filter',
                title: `${filterField}=${filterValue} filter returns non-matching items: ${path}`,
                steps: [`GET ${path}?${filterField}=${encodeURIComponent(filterValue)}`, `Check each returned item's "${filterField}" value`],
                expected: `Every returned item should have ${filterField}="${filterValue}"`,
                actual: `${mismatched.length} of ${filteredList.items.length} returned item(s) have a different "${filterField}" value`,
                evidence: writeApiEvidence(ctx, 'filter-mismatch', formatEvidence('GET', `${path}?${filterField}=${encodeURIComponent(filterValue)}`, filteredRes.status, { responseBody: filteredRes.body })),
                reproRate: '1/1',
                automationCandidate: true,
                pageUrl: path,
                confidence: 'heuristic',
                confidenceReason: 'Field-name guessing may have hit an unrelated query param this API ignores — verify the filter param name is correct before treating as confirmed.',
              });
              count++;
            }
          }
        }
      }
    }
  }

  if (count === 0) {
    ctx.onLog(`[FunctionalListing] Checked ${targets.length} listing endpoint(s) — pagination/search counts are internally consistent`);
  }
  return count;
}
