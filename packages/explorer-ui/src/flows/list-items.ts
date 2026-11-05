import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';
import { isUrlInScope } from './helpers.js';

// Shared "what is the main repeating list on this page" detection, used by the outcome-check
// flows (sort-verification, link-target-consistency, duplicate-images, cart-integrity).
//
// Deliberately structural, never site-specific: a product grid, a search-results list, a blog
// index and a table of records all share one shape — a parent with several visually-similar
// siblings, each carrying a name and usually a link, image or price. Grouping siblings by
// tag + stable class signature finds that shape on any framework without hand-written
// selectors (no `.inventory_item`, no `.product-card`). Every matched item is tagged with a
// `data-qa-item` attribute so later steps can re-locate the exact same element by index.

export interface ListItem {
  index: number;
  name: string;
  price: number | null;
  priceText: string | null;
  imgSrc: string | null;
  href: string | null;
}

export interface ListSnapshot {
  items: ListItem[];
  /** CSS selector matching every item in the detected group, in DOM order. */
  itemSelector: string;
}

const ITEM_ATTR = 'data-qa-item';

/**
 * Finds the dominant repeating list on the current page. Returns null when nothing list-like
 * (at least `minItems` similar siblings with readable names) is present — callers treat that as
 * "this check doesn't apply here", never as a defect.
 */
export async function detectListItems(
  page: Page,
  minItems = 3,
  /** Siblings whose text matches this are ignored (e.g. order-summary total/tax rows). */
  exclude?: RegExp,
): Promise<ListSnapshot | null> {
  const result = await page
    .evaluate(
      ({ attr, minItems, excludeSrc }) => {
        const EXCLUDE = excludeSrc ? new RegExp(excludeSrc, 'i') : null;
        const PRICE_RE = /(?:[$€£₹¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|INR)\b)/;
        const isVisible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 20 || r.height < 12) return false;
          const s = getComputedStyle(el as HTMLElement);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const signature = (el: Element) =>
          el.tagName +
          '.' +
          Array.from(el.classList)
            .filter((c) => !/active|selected|current|odd|even|first|last|hover|focus|\d/i.test(c))
            .sort()
            .join('.');
        const cleanText = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

        const nameOf = (item: Element): string => {
          const sel = [
            '[data-test*="name" i]', '[data-testid*="name" i]', '[class*="name" i]',
            '[class*="title" i]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a',
          ];
          for (const s of sel) {
            for (const el of Array.from(item.querySelectorAll(s))) {
              const t = cleanText(el.textContent);
              if (t.length >= 2 && t.length <= 120 && !PRICE_RE.test(t) && isVisible(el)) return t;
            }
          }
          const first = cleanText(item.textContent).slice(0, 80);
          return first;
        };

        // Clear tags from any earlier call on this same page.
        document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));

        let best: { members: Element[]; score: number } | null = null;
        const parents = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
        // Sidebars, top bars and menus are repeating links too, but they are navigation, not
        // a list of records — OrangeHRM's sidebar (Admin, PIM, Leave…) was picked as "the list"
        // and its first entry clicked, leaving the allowed section and reporting a false mismatch.
        const NAV_CONTAINER =
          'nav, aside, header, footer, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], ' +
          '[class*="sidebar" i], [class*="sidenav" i], [class*="side-nav" i], [class*="navbar" i], [class*="main-menu" i]';
        for (const parent of parents) {
          if (parent.children.length < minItems) continue;
          const navAncestor = parent.closest(NAV_CONTAINER);
          // A layout wrapper such as <div class="with-sidebar"> also contains the main content.
          if (navAncestor && !navAncestor.querySelector('main, [role="main"]')) continue;
          const groups = new Map<string, Element[]>();
          for (const child of Array.from(parent.children)) {
            if (!isVisible(child)) continue;
            if (EXCLUDE && EXCLUDE.test(cleanText(child.textContent))) continue;
            const key = signature(child);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(child);
          }
          for (const members of groups.values()) {
            if (members.length < minItems) continue;
            // Every member must look like a self-contained record: some text, not a whole page.
            const textOk = members.every((m) => {
              const len = cleanText(m.textContent).length;
              return len >= 2 && len <= 800;
            });
            if (!textOk) continue;
            const withLink = members.filter((m) => m.querySelector('a, [role="link"], button')).length;
            const withImg = members.filter((m) => m.querySelector('img')).length;
            const withPrice = members.filter((m) => PRICE_RE.test(m.textContent ?? '')).length;
            // Nav bars and button rows are repeating siblings too — require richer records
            // (an image or price on most items, or several text lines) to rank as "the list".
            const richness = (withImg + withPrice) / members.length;
            const multiLine = members.filter((m) => m.querySelectorAll('*').length >= 3).length / members.length;
            if (richness < 0.5 && multiLine < 0.8) continue;
            const names = new Set(members.map(nameOf));
            if (names.size < Math.min(minItems, members.length)) continue;
            const score = members.length * (1 + richness) + withLink * 0.1;
            if (!best || score > best.score) best = { members, score };
          }
        }
        if (!best) return null;

        const items = best.members.map((m, index) => {
          m.setAttribute(attr, String(index));
          const priceMatch = (m.textContent ?? '').match(PRICE_RE);
          const priceText = priceMatch ? priceMatch[0] : null;
          const price = priceText ? parseFloat(priceText.replace(/[^\d.]/g, '')) : null;
          const img = m.querySelector('img') as HTMLImageElement | null;
          const a = m.querySelector('a[href]') as HTMLAnchorElement | null;
          return {
            index,
            name: nameOf(m),
            price: price !== null && Number.isFinite(price) ? price : null,
            priceText,
            imgSrc: img ? img.currentSrc || img.src || null : null,
            href: a ? a.href : null,
          };
        });
        return items;
      },
      { attr: ITEM_ATTR, minItems, excludeSrc: exclude?.source ?? null },
    )
    .catch(() => null);

  if (!result || result.length < minItems) return null;
  return { items: result, itemSelector: `[${ITEM_ATTR}]` };
}

/** Locator for the item at `index` from the most recent detectListItems() call on this page. */
export function itemLocator(page: Page, index: number): Locator {
  return page.locator(`[${ITEM_ATTR}="${index}"]`);
}

/** Up to `n` spread-out indices (first, middle, last…) so checks never only test item 0. */
export function spreadIndices(count: number, n: number): number[] {
  if (count <= n) return [...Array(count).keys()];
  const out = new Set<number>([0, count - 1]);
  for (let i = 1; out.size < n && i < n; i++) out.add(Math.round((i * (count - 1)) / (n - 1)));
  return [...out].sort((a, b) => a - b).slice(0, n);
}

/** Case/whitespace/punctuation-insensitive form used for name comparisons. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** True if two display names plausibly refer to the same thing (containment or ≥60% word overlap). */
export function namesMatch(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wx = new Set(x.split(' ').filter((w) => w.length > 1));
  const wy = new Set(y.split(' ').filter((w) => w.length > 1));
  if (wx.size === 0 || wy.size === 0) return false;
  let shared = 0;
  for (const w of wx) if (wy.has(w)) shared++;
  return shared / Math.min(wx.size, wy.size) >= 0.6;
}

export async function snap(page: Page, ctx: ExecutorContext, name: string): Promise<string[]> {
  const path = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path, fullPage: false, timeout: 5000 });
    return [path];
  } catch {
    return [];
  }
}

/** Same-origin routes discovered earlier in the session (BFS crawl / site cache), deduped. */
export function sameOriginRoutes(ctx: ExecutorContext, startUrl: string, max: number): string[] {
  let origin: string;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>([startUrl.split('#')[0]]);
  for (const r of [...(ctx.visitedRoutes ?? []), ...(ctx.discoveredRoutes ?? [])]) {
    let abs: string;
    try {
      abs = new URL(r, origin).toString().split('#')[0];
    } catch {
      continue;
    }
    if (!abs.startsWith(origin) || seen.has(abs)) continue;
    if (/logout|sign-?out|delete|remove/i.test(abs)) continue;
    // Respect the user's section restriction — never open a known route outside it.
    if (!isUrlInScope(abs, ctx.config.allowedSections)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= max) break;
  }
  return out;
}
