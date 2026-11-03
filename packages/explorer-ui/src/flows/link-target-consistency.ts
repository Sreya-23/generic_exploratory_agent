import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage, isRiskyActionLabel } from './helpers.js';
import { detectListItems, itemLocator, namesMatch, normalizeName, snap, spreadIndices } from './list-items.js';

// A18 — Link-target consistency. dead-links.ts only asks "does the link load something?" — a
// list whose item links open the WRONG record (off-by-one id, stale cache, mixed-up routing)
// loads perfectly well and passes every existing check. This opens a spread of items (first,
// middle, last — never only item 0, since index-dependent bugs are the common failure mode) and
// checks the page that opens is actually about the item that was clicked: its main heading
// should match the item's name, and its price (when both show one) should match too.

const MAX_ITEMS = 3;

async function detailHeading(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
      const candidates = [
        '[data-test*="name" i]', '[data-testid*="name" i]', 'h1', '[class*="title" i]', '[class*="name" i]', 'h2',
      ];
      for (const sel of candidates) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const t = clean(el.textContent);
          if (r.width > 0 && r.height > 0 && t.length >= 2 && t.length <= 150) return t;
        }
      }
      return clean(document.title);
    })
    .catch(() => '');
}

async function pageText(page: Page): Promise<string> {
  return (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) ?? '';
}

export async function runLinkTargetConsistency(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[LinkTarget] Login wall — skipping');
    return;
  }
  const listUrl = page.url();
  const first = await detectListItems(page);
  if (!first) {
    ctx.onLog('[LinkTarget] No repeating list of items on this page — nothing to check');
    return;
  }
  const allNames = first.items.map((i) => i.name);
  let opened = 0;

  for (const idx of spreadIndices(first.items.length, MAX_ITEMS)) {
    // Re-detect each time: going back may re-render the list and drop our item tags.
    if (page.url() !== listUrl) await page.goto(listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const list = await detectListItems(page);
    const item = list?.items[idx];
    if (!list || !item) continue;

    const container = itemLocator(page, idx);
    // Prefer the element carrying the item's own name (that's what a user clicks), else its first link.
    let target = container.getByText(item.name, { exact: true }).first();
    if ((await target.count().catch(() => 0)) === 0) target = container.locator('a[href], [role="link"]').first();
    if ((await target.count().catch(() => 0)) === 0) continue;
    if (isRiskyActionLabel(item.name)) continue;

    const beforeUrl = page.url();
    const beforeHeading = await detailHeading(page);
    await target.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(800);

    const afterUrl = page.url();
    const heading = await detailHeading(page);
    if (afterUrl === beforeUrl && heading === beforeHeading) {
      ctx.onLog(`[LinkTarget] Clicking "${item.name}" did not open anything — not a link, skipped`);
      continue;
    }
    opened++;

    const text = await pageText(page);
    // A heading that is exactly another item's name is a wrong page even when the two names
    // share most of their words (a brand prefix such as "Acme Labs Backpack" vs "Acme Labs
    // Jacket" fuzzy-matches) — so check exact names before the fuzzy comparison.
    const exactName = (n: string) => {
      const h = normalizeName(heading);
      const x = normalizeName(n);
      return !!h && !!x && (h === x || h.includes(x));
    };
    const exactOther = exactName(item.name) ? undefined : allNames.find((n) => n !== item.name && exactName(n));
    const nameShown = !exactOther && (namesMatch(heading, item.name) || text.toLowerCase().includes(item.name.toLowerCase()));
    if (!nameShown) {
      // Strong signal: the detail page names a DIFFERENT item from the same list.
      const otherMatch = exactOther ?? allNames.find((n) => n !== item.name && namesMatch(heading, n));
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-LinkTarget',
        title: `Opening "${item.name}" shows a different item${otherMatch ? ` ("${otherMatch}")` : ''}`,
        steps: [`Open ${listUrl}`, `Click "${item.name}" (item ${idx + 1} in the list)`, 'Read the heading of the page that opens'],
        expected: `The page that opens is about "${item.name}"`,
        actual: `Page ${afterUrl} is titled "${heading}" and never mentions "${item.name}"`,
        evidence: await snap(page, ctx, 'link-target-mismatch'),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: listUrl,
        confidence: otherMatch ? 'verified' : 'heuristic',
        confidenceReason: otherMatch
          ? 'The opened page is titled with the name of another item from the same list.'
          : 'Heading/text comparison only — a detail page that names the item differently would also trip this.',
      });
    } else if (item.priceText && item.price !== null) {
      const prices = (text.match(/[$€£₹¥]\s?\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map((p) => parseFloat(p.replace(/[^\d.]/g, '')));
      if (prices.length > 0 && !prices.some((p) => Math.abs(p - item.price!) < 0.005)) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-LinkTarget',
          title: `Price for "${item.name}" differs between the list and its detail page`,
          steps: [`Open ${listUrl}`, `Note the price of "${item.name}" (${item.priceText})`, 'Click the item and compare the price shown'],
          expected: `Detail page shows the same price as the list (${item.priceText})`,
          actual: `Detail page shows ${prices.slice(0, 3).join(', ')} instead`,
          evidence: await snap(page, ctx, 'link-target-price'),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: afterUrl,
          confidence: 'heuristic',
          confidenceReason: 'Compares currency amounts in page text; a detail page that only shows a discounted or per-unit price would also trip this.',
        });
      } else {
        ctx.onLog(`[LinkTarget] "${item.name}" opens the matching detail page`);
      }
    } else {
      ctx.onLog(`[LinkTarget] "${item.name}" opens the matching detail page`);
    }

    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  if (opened === 0) ctx.onLog('[LinkTarget] No list item opened a separate page — nothing to compare');
}
