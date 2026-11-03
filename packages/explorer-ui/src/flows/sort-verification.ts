import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { elementFingerprint, isLoginWallPage } from './helpers.js';
import { detectListItems, snap, type ListItem } from './list-items.js';

// A17 — Sort correctness. pagination-ui.ts's checkSortControl only asks "does clicking a sortable
// table header change the row order at all?" — a sort that reorders the WRONG way, or a sort
// dropdown that changes its own value while the list underneath stays put, passes that check.
// This one reads what each sort option PROMISES from its own label ("Price (low to high)",
// "Name (Z to A)") and verifies the visible list actually satisfies that order, using the
// structural list detection in list-items.ts — so it works on product grids, search results and
// record lists alike, not just <table>s. Options whose label makes no checkable promise
// ("Popular", "Recommended") are logged and skipped, never guessed at.

type Expectation =
  | { kind: 'name'; dir: 'asc' | 'desc' }
  | { kind: 'price'; dir: 'asc' | 'desc' }
  | null;

const SORT_HINT = /\bsort|order\s*by|\bsort[_-]?by|arrange/i;
const SORT_OPTION_HINT = /a\s*(?:to|-|–|→)\s*z|z\s*(?:to|-|–|→)\s*a|low\s*(?:to|-|–|→)\s*high|high\s*(?:to|-|–|→)\s*low|price|name|alphabet|ascending|descending|cheapest|lowest|highest/i;

export function expectationFromLabel(label: string): Expectation {
  const l = label.toLowerCase();
  if (/z\s*(?:to|-|–|→)\s*a|name.*desc|reverse alphabet/.test(l)) return { kind: 'name', dir: 'desc' };
  if (/a\s*(?:to|-|–|→)\s*z|name.*asc|alphabetical/.test(l)) return { kind: 'name', dir: 'asc' };
  if (/high\s*(?:to|-|–|→)\s*low|price.*desc|highest|most expensive/.test(l)) return { kind: 'price', dir: 'desc' };
  if (/low\s*(?:to|-|–|→)\s*high|price.*asc|lowest|cheapest/.test(l)) return { kind: 'price', dir: 'asc' };
  return null;
}

/** First index where the sequence breaks the expected order, or -1 if it's correctly sorted. */
export function firstOrderViolation(items: ListItem[], exp: NonNullable<Expectation>): number {
  const sign = exp.dir === 'asc' ? 1 : -1;
  for (let i = 1; i < items.length; i++) {
    let cmp: number;
    if (exp.kind === 'price') {
      const a = items[i - 1].price;
      const b = items[i].price;
      if (a === null || b === null) continue;
      cmp = a === b ? 0 : a < b ? -1 : 1;
    } else {
      cmp = items[i - 1].name.localeCompare(items[i].name, undefined, { sensitivity: 'base', numeric: true });
    }
    if (cmp * sign > 0) return i;
  }
  return -1;
}

async function findSortSelects(page: Page) {
  const selects = page.locator('select:visible');
  const count = Math.min(await selects.count().catch(() => 0), 10);
  const found: { index: number; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const info = await selects
      .nth(i)
      .evaluate((el) => {
        const s = el as HTMLSelectElement;
        const own = [s.name, s.id, s.getAttribute('aria-label'), s.getAttribute('data-test'), s.className].join(' ');
        const labelEl = s.id ? document.querySelector(`label[for="${s.id}"]`) : null;
        const options = Array.from(s.options).map((o) => o.textContent?.trim() ?? '');
        return { own: `${own} ${labelEl?.textContent ?? ''}`, options };
      })
      .catch(() => null);
    if (!info) continue;
    const optionHits = info.options.filter((o) => SORT_OPTION_HINT.test(o)).length;
    if (SORT_HINT.test(info.own) || optionHits >= 2) {
      found.push({ index: i, label: info.own.replace(/\s+/g, ' ').trim().slice(0, 60) || 'sort control' });
    }
  }
  return { selects, found };
}

export async function runSortVerification(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[SortCheck] Login wall — no list to sort here, skipping');
    return;
  }

  const { selects, found } = await findSortSelects(page);
  if (found.length === 0) {
    ctx.onLog('[SortCheck] No sort dropdown found on this page — nothing to verify');
    return;
  }

  for (const { index, label } of found.slice(0, 2)) {
    const select = selects.nth(index);
    const original = await select.inputValue().catch(() => '');
    const listUrl = page.url().split('#')[0];
    const target = (await elementFingerprint(select)) ?? undefined;
    const failures: { option: string; detail: string; exp: NonNullable<Expectation> }[] = [];
    const options = await select
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? '' })))
      .catch(() => [] as { value: string; text: string }[]);

    let checked = 0;
    for (const opt of options.slice(0, 6)) {
      const exp = expectationFromLabel(opt.text);
      if (!exp) {
        ctx.onLog(`[SortCheck] Option "${opt.text}" makes no checkable ordering promise — skipped`);
        continue;
      }
      const urlBefore = page.url();
      await select.selectOption(opt.value, { timeout: 5000 }).catch(() => {});
      if (page.url() !== urlBefore) await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(900);

      const list = await detectListItems(page);
      if (!list) {
        ctx.onLog(`[SortCheck] After choosing "${opt.text}" no list could be detected — skipped`);
        continue;
      }
      if (exp.kind === 'price' && list.items.filter((i) => i.price !== null).length < 3) {
        ctx.onLog(`[SortCheck] "${opt.text}" sorts by price but fewer than 3 items show a price — skipped`);
        continue;
      }
      checked++;
      const bad = firstOrderViolation(list.items, exp);
      const shown = list.items
        .slice(0, 6)
        .map((it) => (exp.kind === 'price' ? `${it.name} (${it.priceText ?? '?'})` : it.name))
        .join(' → ');
      if (bad === -1) {
        ctx.onLog(`[SortCheck] "${opt.text}" correctly orders ${list.items.length} items`);
        continue;
      }
      const prev = list.items[bad - 1];
      const cur = list.items[bad];
      failures.push({
        option: opt.text,
        exp,
        detail:
          `item ${bad} ("${prev.name}"${exp.kind === 'price' ? ` ${prev.priceText}` : ''}) comes before item ${bad + 1} ` +
          `("${cur.name}"${exp.kind === 'price' ? ` ${cur.priceText}` : ''}); list shows ${shown}`,
      });
    }

    if (failures.length > 0) {
      const names = failures.map((f) => `"${f.option}"`).join(', ');
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Sort',
        title:
          failures.length === 1
            ? `Sort option ${names} does not order the list as labelled`
            : `${failures.length} sort options do not order the list as labelled (${names})`,
        steps: [`Open ${listUrl}`, `Choose each of ${names} in the ${label} control`, 'Read the order of the items in the list'],
        expected: 'Each sort option orders the visible items the way its label says',
        actual: failures.map((f) => `${f.option}: ${f.detail}`).join(' | '),
        evidence: await snap(page, ctx, 'sort-wrong-order'),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: listUrl,
        targetSelector: target,
        confidence: 'verified',
        confidenceReason: 'Directly compares the displayed names/prices against the ordering each option label states.',
      });
    }

    if (checked === 0) ctx.onLog(`[SortCheck] ${label}: no option with a checkable order`);
    if (original) await select.selectOption(original).catch(() => {});
  }
}
