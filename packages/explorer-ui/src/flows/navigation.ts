import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { findVisibleErrorText, explorationBreadth, dismissBlockingOverlay, isRiskyActionLabel } from './helpers.js';

interface NavPage {
  url: string;
  title: string;
  reachedBy: string; // label of the nav item clicked
  depth: number;
  screenshot: string;
  issues: string[];
}

// ── Selectors for clickable navigation surfaces ──────────────────────────────
// Each group targets a different UI pattern. Ordered: most-specific first.
//
// The href-requiring groups below assume the app uses real <a href> elements for
// navigation. Many real-world SPA dashboards (React/Vue/Angular client-side routers)
// instead render sidebar/nav items as <button> or plain clickable <div>/<li> with an
// onClick handler that calls history.pushState directly — no href anywhere. Requiring
// a[href] on every sidebar/nav selector makes those completely invisible to this crawl
// (it'll report "0 nav items" on a page that visibly has a full working sidebar), even
// though action-inventory's much broader "any button" selector still finds them fine.
// Each href-based group below has a sibling entry covering the no-href case.
const NAV_CLICK_SELECTORS = [
  // Hamburger / drawer triggers (must click to reveal hidden menu)
  '[class*="burger"]',
  '[class*="hamburger"]',
  '[class*="menu-toggle"]',
  '[class*="nav-toggle"]',
  '[aria-label*="menu" i]',
  '[aria-label*="open navigation" i]',
  // Sidebar nav items — semantic <aside>, then common class-name conventions
  'aside a[href]',
  'aside button',
  'aside [role="button"]',
  '[class*="sidebar"] a[href]',
  '[class*="sidebar"] button',
  '[class*="sidebar"] [role="button"]',
  '[class*="side-nav"] a[href]',
  '[class*="side-nav"] button',
  '[class*="side-menu"] a[href]',
  '[class*="side-menu"] button',
  '[class*="drawer"] a[href]',
  '[class*="drawer"] button',
  // Top-nav / header links
  'nav a[href]',
  'nav button',
  'header a[href]',
  'header button',
  '[role="navigation"] a[href]',
  '[role="navigation"] button',
  // Tab bars
  '[role="tab"]',
  '[class*="tab-item"]',
  '[class*="tab-link"]',
  // Dropdown triggers
  '[aria-haspopup="true"]',
  '[data-toggle="dropdown"]',
  '[class*="dropdown-toggle"]',
  // Generic menu items that are visible
  '[class*="menu-item"] a[href]',
  '[class*="menu-item"] button',
  '[class*="nav-item"] a[href]',
  '[class*="nav-item"] button',
  '[class*="nav-link"]',
];

// ── Selectors that reveal hidden navigation panels ──────────────────────────
const REVEAL_TRIGGERS = [
  '[class*="burger"]',
  '[class*="hamburger"]',
  '[class*="menu-toggle"]',
  '[class*="nav-toggle"]',
  '[aria-label*="menu" i]',
  '[aria-haspopup="true"]',
  '[data-toggle="dropdown"]',
  // Account/profile dropdown trigger (avatar + chevron, top-right corner) — a very common
  // pattern that often hides a large chunk of real navigation (settings, billing, org admin,
  // docs) behind it. Confirmed real gap: a real app's account menu used none of the ARIA/
  // data-toggle markers above (no aria-haspopup, no role), just a plain clickable avatar —
  // the same "no semantic markup" pattern this codebase has hit before (the modal-overlay
  // fix, for the same underlying reason). Matched broadly since there's no single reliable
  // semantic signal for this pattern the way there is for a real hamburger icon.
  '[class*="avatar"]',
  '[aria-label*="account" i]',
  '[aria-label*="profile" i]',
  '[aria-label*="user menu" i]',
  '[data-testid*="avatar" i]',
  '[data-testid*="user-menu" i]',
  '[data-testid*="account-menu" i]',
];

/**
 * Click all known reveal triggers (hamburger, dropdowns) to expose hidden
 * navigation panels, then return all newly visible navigation links.
 */
async function revealHiddenNav(page: Page): Promise<void> {
  for (const sel of REVEAL_TRIGGERS) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      await el.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  await revealTopRightAccountMenu(page);
}

// Confirmed real gap: a real app's account/profile menu trigger was a plain <div
// role="presentation"> with generic Tailwind utility classes — no aria-label, no
// aria-haspopup, no class name containing "avatar"/"profile"/"account", nothing any CSS
// selector above could match, because there was no semantic signal in the markup at all
// (role="presentation" on a genuinely interactive control is itself an accessibility bug —
// it tells assistive tech to ignore an element that isn't decorative). Rather than chase an
// ever-growing list of naming conventions that a site is free to not use, this matches on
// POSITION and SHAPE instead: a small, cursor-pointer element sitting in the page's top-right
// corner with short text (often initials) is a near-universal convention for an account menu
// across real sites, independent of whatever markup happens to implement it.
async function revealTopRightAccountMenu(page: Page): Promise<void> {
  const candidateHandles = await page
    .evaluateHandle(() => {
      const viewportWidth = window.innerWidth;
      const found: Element[] = [];
      const all = Array.from(document.querySelectorAll('button, [role="button"], div, span, a'));
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Top-right corner, small element, roughly square-ish (avatar/icon shape) —
        // excludes wide top bars/nav strips that also happen to be near the top.
        if (
          rect.top < 100 &&
          rect.right > viewportWidth - 260 &&
          rect.width > 10 &&
          rect.width < 120 &&
          rect.height > 10 &&
          rect.height < 80
        ) {
          const style = window.getComputedStyle(el);
          if (style.cursor === 'pointer') found.push(el);
        }
      }
      return found.slice(0, 3);
    })
    .catch(() => null);

  if (!candidateHandles) return;

  try {
    const properties = await candidateHandles.getProperties();
    for (const handle of properties.values()) {
      const el = handle.asElement();
      if (!el) continue;
      await el.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  } finally {
    await candidateHandles.dispose().catch(() => {});
  }
}

interface NavItem {
  label: string;
  href: string | null;
  selector: string;
  kind: 'link' | 'tab' | 'button';
}

/**
 * Collect all distinct navigation items currently visible on the page.
 * Covers: links in nav/sidebar/header, tabs, and hamburger-revealed panels.
 */
async function collectNavItems(page: Page, baseOrigin: string): Promise<NavItem[]> {
  // Poll for nav content to render before giving up — client-rendered SPAs (Vue/React/Angular
  // sidebars, common in real-world dashboards) often mount their nav a beat after
  // 'domcontentloaded', so a single same-tick scan can find zero items on an otherwise
  // link-rich page.
  const deadline = Date.now() + 5000;
  let items = await collectNavItemsOnce(page, baseOrigin);
  while (items.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(400);
    items = await collectNavItemsOnce(page, baseOrigin);
  }
  return items;
}

async function collectNavItemsOnce(page: Page, baseOrigin: string): Promise<NavItem[]> {
  const items: NavItem[] = [];
  const seen = new Set<string>();

  // First reveal any hidden panels
  await revealHiddenNav(page);
  await page.waitForTimeout(300);

  async function collectFrom(sel: string): Promise<void> {
    const els = await page.locator(sel).all();
    for (const el of els) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;

      const label = ((await el.textContent().catch(() => '')) ?? '').trim().slice(0, 60);
      const href = await el.getAttribute('href').catch(() => null);
      const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');

      // Skip empty labels, anchor-only links, and external links
      if (!label && !href) continue;
      if (href === '#' || href?.startsWith('javascript:')) continue;
      if (href && !href.startsWith('/') && !href.startsWith(baseOrigin) &&
          !href.startsWith('http://') && !href.startsWith('https://')) continue;

      // A bare number with no href is almost always a pagination control or a count
      // badge, not a distinct page to crawl — clicking through "1", "2", "16", "124" wastes
      // budget on what's really the same page's pagination, not real site coverage.
      if (!href && /^\d+$/.test(label)) continue;

      // Normalise to absolute URL for deduplication
      let fullHref: string | null = null;
      if (href) {
        try {
          const u = new URL(href, baseOrigin);
          if (u.origin !== new URL(baseOrigin).origin) continue; // external
          fullHref = u.toString();
        } catch {
          continue;
        }
      }

      const key = fullHref ?? `btn:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        label: label || href || 'unnamed',
        href: fullHref,
        selector: sel,
        kind: tag === 'a' ? 'link' : tag === 'button' ? 'button' : 'tab',
      });
    }
  }

  for (const sel of NAV_CLICK_SELECTORS) {
    await collectFrom(sel);
  }

  // Fallback: any visible, same-origin <a href> on the page at all — not scoped to any
  // container. The scoped selectors above assume nav/sidebar markup uses SOME recognizable
  // signal (a semantic tag, or a class name containing "sidebar"/"nav-item"/etc.) — plenty
  // of real sites (Tailwind-styled apps especially) use neither, just plain utility classes
  // like "flex items-center gap-3 px-4 py-3" with zero semantic naming. On those, every
  // scoped selector above matches nothing even though the page is full of real internal
  // links. Same dedup applies, so this only adds links the scoped passes missed.
  await collectFrom('a[href]');

  return items;
}

/**
 * Check a page for common issues: JS errors, broken images, empty content.
 */
async function auditPage(page: Page): Promise<string[]> {
  const issues: string[] = [];

  // Broken images
  const brokenImages = await page.$$eval('img[src]', (imgs) =>
    (imgs as HTMLImageElement[]).filter((i) => i.naturalWidth === 0 && i.complete).map((i) => i.src),
  ).catch(() => [] as string[]);
  if (brokenImages.length > 0) {
    issues.push(`${brokenImages.length} broken image(s): ${brokenImages.slice(0, 2).join(', ')}`);
  }

  // Meaningful page content check (not blank)
  const bodyText = (await page.locator('body').textContent().catch(() => ''))?.trim() ?? '';
  if (bodyText.length < 50) {
    issues.push('Page appears blank or has very little content');
  }

  // Missing page title
  const title = await page.title().catch(() => '');
  if (!title || title.length < 2) {
    issues.push('Page has no <title>');
  }

  // Look for visible error text — uses the shared, size-ordered helper rather than a raw
  // `.first()` match, which can grab a large wrapping container's full concatenated text.
  const errorText = await findVisibleErrorText(page, 0);
  if (errorText) {
    issues.push(`Error message on page: "${errorText.trim().slice(0, 80)}"`);
  }

  return issues;
}

export async function runNavigation(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const startUrl = page.url();
  const baseOrigin = new URL(ctx.config.targetUrl).origin;

  ctx.onLog(`[Navigation] Starting authenticated site traversal from: ${startUrl}`);

  const visitedUrls = new Set<string>([startUrl]);
  const visitedKeys = new Set<string>(); // covers click-only items too (no href to dedup by)
  const visitedTabStates = new Set<string>(); // url+tab-label — state within a URL, not just the URL itself
  const visitedPages: NavPage[] = [];
  interface QueueItem {
    url: string | null;
    label: string;
    depth: number;
    // For items with no href (client-router buttons/divs) — where to click FROM, and
    // which selector group to re-locate the element with once we're back on that page.
    selector?: string;
    discoveredOnUrl?: string;
  }
  const queue: QueueItem[] = [];

  // Collect initial nav from the landing/post-login page
  const initialItems = await collectNavItems(page, baseOrigin);
  ctx.onLog(`[Navigation] Discovered ${initialItems.length} nav items on entry page`);

  for (const item of initialItems) {
    queue.push({ url: item.href, label: item.label, depth: 1, selector: item.selector, discoveredOnUrl: startUrl });
  }

  // BFS — visit each discovered page, then discover its nav items. Scale by session depth —
  // a smoke run should sample a few pages quickly, a deep run should sweep much further.
  const MAX_PAGES = explorationBreadth(ctx, { smoke: 8, standard: 25, deep: 60, chaos: 8 });
  const MAX_DEPTH = explorationBreadth(ctx, { smoke: 2, standard: 3, deep: 4, chaos: 2 });

  // ── Network API call capture ────────────────────────────────────────────────
  // Monitor all XHR/fetch requests made by the authenticated app during BFS.
  // These are the REAL endpoints used by the app — much better than guesses.
  const capturedApiEndpoints = new Set<string>();
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
    try {
      const u = new URL(req.url());
      // Only capture paths from the same origin (not CDN/analytics calls)
      if (u.origin === baseOrigin && u.pathname !== '/') {
        capturedApiEndpoints.add(`${req.method()} ${u.pathname}${u.search ? u.search.split('&')[0] : ''}`);
      }
    } catch { /* ignore invalid URLs */ }
  });
  // ───────────────────────────────────────────────────────────────────────────

  // Collect JS console errors globally
  const jsErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') jsErrors.push(msg.text().slice(0, 120));
  });
  page.on('pageerror', (err) => jsErrors.push(err.message.slice(0, 120)));

  while (queue.length > 0 && visitedPages.length < MAX_PAGES) {
    const next = queue.shift()!;
    if (next.depth > MAX_DEPTH) continue;

    if (next.url) {
      if (visitedUrls.has(next.url)) continue;
      visitedUrls.add(next.url);
    } else {
      // Client-router item with no href — dedupe by label alone, not by where it was
      // discovered. A persistent sidebar/nav item's destination doesn't depend on which
      // page you clicked it from, so without this a persistent nav re-discovered on every
      // page gets queued and fully re-visited once per discovery context — e.g. a 3-item
      // sidebar on 3 pages turns into 9+ redundant visits of the same 3 destinations
      // instead of 3, wasting exactly the kind of budget removeUnlikelyTasks/breadth
      // scaling elsewhere is trying to protect.
      if (!next.selector) continue;
      if (visitedKeys.has(next.label)) continue;
      visitedKeys.add(next.label);
    }

    try {
      let httpStatus = 0;
      if (next.url) {
        ctx.onLog(`[Navigation] Visiting [depth ${next.depth}]: "${next.label}" → ${next.url}`);
        const response = await page.goto(next.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(500);
        httpStatus = response?.status() ?? 0;
      } else {
        // No href to load directly. Most sidebars/nav bars are PERSISTENT across pages —
        // the item is very likely still right here on whatever page we currently happen to
        // be on, with zero navigation needed. Only fall back to reloading discoveredOnUrl
        // (a full page load) if it genuinely isn't on the current page — reloading a
        // client-side-only route from scratch isn't guaranteed to work at all (a plain
        // static file server, or any SPA host without a catch-all rewrite to index.html,
        // 404s on a direct load of a route that only ever existed via history.pushState).
        ctx.onLog(`[Navigation] Visiting [depth ${next.depth}]: "${next.label}" (click, no href)`);
        let target = page.locator(next.selector!).filter({ hasText: next.label }).first();
        if ((await target.count().catch(() => 0)) === 0) {
          await page.goto(next.discoveredOnUrl!, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(500);
          target = page.locator(next.selector!).filter({ hasText: next.label }).first();
        }
        if ((await target.count().catch(() => 0)) === 0) {
          ctx.onLog(`[Navigation] Could not re-locate "${next.label}" (tried current page and ${next.discoveredOnUrl}) — skipping`);
          continue;
        }
        // A modal left open by a PREVIOUS nav item's click (one this same crawl already
        // triggered) blocks this click identically — and because the click below is
        // swallowed with .catch(() => {}), a silent failure here doesn't just miss one page,
        // it makes the crawl audit whatever page it's still actually on and never discover
        // that destination's own children, quietly shrinking the whole rest of the crawl.
        await dismissBlockingOverlay(page).catch(() => {});
        await target.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(800);
      }

      const pageTitle = await page.title().catch(() => '');
      const finalUrl = page.url();
      visitedUrls.add(finalUrl);

      // §2 — unexpected external redirect. next.url is only ever queued same-origin (the
      // "external" links are filtered out of the BFS queue entirely at discovery time — see
      // the `u.origin !== baseOrigin` skip above), so landing on a different origin after
      // navigating one of these is always a genuine redirect the app itself performed, not a
      // link that was external to begin with.
      if (next.url) {
        try {
          const intendedOrigin = new URL(next.url).origin;
          const finalOrigin = new URL(finalUrl).origin;
          if (intendedOrigin !== finalOrigin) {
            ctx.onFinding({
              severity: 'low',
              area: 'Navigation',
              title: `Internal link redirects to a different domain`,
              steps: [`Click/navigate "${next.label}" (${next.url})`],
              expected: 'An internal navigation link stays on the same domain unless it is a known third-party integration (SSO/payment gateway)',
              actual: `Navigating to ${next.url} ended up on ${finalUrl} (${finalOrigin}) instead`,
              evidence: [],
              reproRate: '1/1',
              automationCandidate: true,
              pageUrl: next.url,
              confidence: 'heuristic',
              confidenceReason: 'A same-origin-at-discovery-time link ending up cross-origin is common and legitimate for SSO/OAuth login and payment gateway redirects — verify this specific case isn\'t one of those before treating it as a bug.',
            });
          }
        } catch {
          /* malformed URL — nothing to compare */
        }
      }

      const shotName = `nav-${visitedPages.length}-${next.label.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`;
      const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${shotName}.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

      const pageIssues = await auditPage(page);
      const reachedVia = next.url ? `Navigate to: ${next.url}` : `Click "${next.label}" (from ${next.discoveredOnUrl})`;

      // HTTP error check — only meaningful for href-based navigation
      if (httpStatus >= 400) {
        pageIssues.push(`HTTP ${httpStatus}`);
        ctx.onFinding({
          severity: httpStatus >= 500 ? 'high' : 'medium',
          area: 'UI-Navigation',
          title: `Broken link: "${next.label}" returns HTTP ${httpStatus}`,
          steps: [reachedVia, `Link reached via: "${next.label}"`],
          expected: 'Page loads with 2xx status',
          actual: `HTTP ${httpStatus} — ${next.url}`,
          evidence: [shotPath],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }

      // Report page issues found during audit
      for (const issue of pageIssues) {
        if (issue.startsWith('HTTP')) continue; // already reported above
        ctx.onFinding({
          severity: issue.includes('blank') || issue.includes('error message') ? 'medium' : 'low',
          area: 'UI-Navigation',
          title: `Page issue on "${next.label}": ${issue}`,
          steps: [reachedVia, 'Inspect page content'],
          expected: 'Page renders correctly with content',
          actual: issue,
          evidence: [shotPath],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: finalUrl,
        });
      }

      visitedPages.push({
        url: finalUrl,
        title: pageTitle,
        reachedBy: next.label,
        depth: next.depth,
        screenshot: shotPath,
        issues: pageIssues,
      });

      ctx.onLog(`[Navigation] ✓ "${pageTitle}" (${finalUrl}) — ${pageIssues.length === 0 ? 'no issues' : pageIssues.join('; ')}`);

      // "Explored" should mean explored STATE, not just visited URL — a tab strip
      // (Recent/Paid/Pending/Partially Paid on a transactions page, say) can hold several
      // meaningfully different states behind the exact same URL, invisible to URL-based
      // dedup entirely. Detect same-URL tab groups and treat each one as its own state to
      // audit, keyed by url+tab-label rather than url alone.
      const hasPasswordInputForTabs = await page.locator('input[type="password"]').count().catch(() => 0);
      if (hasPasswordInputForTabs === 0) {
        const tabs = await page.evaluate(() => {
          const ariaActive = (el: Element) =>
            el.getAttribute('aria-selected') === 'true' ||
            el.getAttribute('aria-current') !== null ||
            /active|selected|current/i.test(el.className?.toString() ?? '');
          const isClickable = (el: Element) => {
            const s = window.getComputedStyle(el);
            return s.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab';
          };
          // Confirmed via live repro against a real tab strip: a plain <div class="cursor-
          // pointer"> wrapping an inner text-styled <div> (no role/aria at all — the same
          // "no semantic markup" pattern this codebase has hit repeatedly: the modal
          // overlay, the account-menu trigger). The color utility class lives on that INNER
          // div, not the clickable wrapper, so descend through single-child wrapper chains
          // to reach the element that actually carries the active/inactive text color.
          const textStyledDescendant = (el: Element): Element => {
            let cur = el;
            while (cur.children.length === 1 && cur.textContent?.trim() === cur.children[0].textContent?.trim()) {
              cur = cur.children[0];
            }
            return cur;
          };
          const textColor = (el: Element) => window.getComputedStyle(textStyledDescendant(el)).color;
          // Background-color pills (active tab gets a filled/tinted background, inactive
          // ones don't) are at least as common a pattern as a text-color change — checked on
          // the OUTER clickable wrapper, since that's typically where a background utility
          // class is applied, not the inner text node.
          const bgColor = (el: Element) => window.getComputedStyle(el).backgroundColor;

          // Given a color-extractor, find a group of siblings where exactly one has a color
          // that differs from what the rest share — "N same-styled labels, one visually
          // highlighted" is a reliable tab-strip signal regardless of which CSS property
          // happens to carry it on a given site.
          function findOutlierGroup(
            groups: Map<Element, Element[]>,
            colorOf: (el: Element) => string,
          ): { siblings: Element[]; activeSet: Set<Element> } | null {
            for (const siblings of groups.values()) {
              if (siblings.length < 3 || siblings.length > 8) continue;
              const texts = siblings.map((el) => (el.textContent || '').trim());
              if (texts.some((t) => !t || t.length > 40)) continue;
              if (new Set(texts).size !== texts.length) continue; // labels must be distinct
              const colors = siblings.map(colorOf);
              const counts = new Map<string, number>();
              for (const c of colors) counts.set(c, (counts.get(c) ?? 0) + 1);
              const majorityCount = Math.max(...counts.values());
              const minority = [...counts.entries()].filter(([, n]) => n < majorityCount);
              if (minority.length !== 1 || minority[0][1] !== 1) continue; // exactly one outlier = one active tab
              return { siblings, activeSet: new Set(siblings.filter((el, i) => colors[i] === minority[0][0])) };
            }
            return null;
          }

          // role="tab" is the semantic fast path. Otherwise: group same-parent clickable
          // elements, and try text-color first, then background-color as a fallback — two
          // independent, common ways a site visually marks "this one's active."
          let candidates = Array.from(document.querySelectorAll('[role="tab"]'));
          let activeSet: Set<Element> | null = candidates.length >= 2 ? new Set(candidates.filter(ariaActive)) : null;

          if (candidates.length < 2) {
            const groups = new Map<Element, Element[]>();
            for (const el of Array.from(document.querySelectorAll('div, span, button, a, li'))) {
              if (!isClickable(el)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const parent = el.parentElement;
              if (!parent) continue;
              const list = groups.get(parent) ?? [];
              list.push(el);
              groups.set(parent, list);
            }
            const found = findOutlierGroup(groups, textColor) ?? findOutlierGroup(groups, bgColor);
            if (found) {
              candidates = found.siblings;
              activeSet = found.activeSet;
            }
          }
          return candidates
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => ({ label: (el.textContent || '').trim().slice(0, 40), active: activeSet?.has(el) ?? false }))
            .filter((t) => t.label.length > 0 && t.label.length < 40);
        }).catch(() => [] as Array<{ label: string; active: boolean }>);

        const nonActiveTabs = tabs.filter((t) => !t.active).slice(0, 5); // bounded — this is a supplementary pass, not the main budget
        for (const tab of nonActiveTabs) {
          // Same safety rule every other click-driven flow in this codebase follows — a
          // "tab" is just a label the color-outlier heuristic happened to group with others;
          // nothing guarantees it can't coincide with a risky-sounding action (Archive,
          // Delete, etc.) on some site's actual UI. Gate it the same way, don't special-case
          // this pass as exempt just because it usually IS just Recent/Paid/Pending.
          if (isRiskyActionLabel(tab.label)) {
            ctx.onLog(`[Navigation] Skipping tab "${tab.label}" — matches a risky-action pattern`);
            continue;
          }
          const stateKey = `${finalUrl}::tab:${tab.label}`;
          if (visitedTabStates.has(stateKey)) continue;
          visitedTabStates.add(stateKey);

          // Exact text match, not hasText (substring) — confirmed via live repro that
          // hasText: 'Paid' also matches inside "Partially Paid", and .last() on that
          // broad a substring match silently clicked the wrong tab entirely.
          const tabTarget = page.getByText(tab.label, { exact: true }).last();
          if ((await tabTarget.count().catch(() => 0)) === 0) continue;
          await dismissBlockingOverlay(page).catch(() => {});
          await tabTarget.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(1000);

          const tabIssues = await auditPage(page);
          const tabShotName = `nav-tab-${visitedPages.length}-${tab.label.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`;
          const tabShotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${tabShotName}.png`);
          await page.screenshot({ path: tabShotPath, fullPage: false }).catch(() => {});

          for (const issue of tabIssues) {
            ctx.onFinding({
              severity: issue.includes('blank') || issue.includes('error message') ? 'medium' : 'low',
              area: 'UI-Navigation',
              title: `Tab state issue on "${pageTitle}" → "${tab.label}": ${issue}`,
              steps: [`Open ${finalUrl}`, `Click the "${tab.label}" tab`, 'Inspect page content'],
              expected: 'Tab content renders correctly',
              actual: issue,
              evidence: [tabShotPath],
              reproRate: '1/1',
              automationCandidate: true,
              pageUrl: finalUrl,
            });
          }

          // Represent this as its own visited "page" using a synthetic, distinguishable URL
          // (real_url#tab:Label) — never a URL the app itself would navigate to, purely a
          // reporting key so tab states show up in page coverage instead of vanishing into
          // the parent URL's single entry.
          visitedPages.push({
            url: `${finalUrl}#tab:${tab.label}`,
            title: `${pageTitle} — ${tab.label}`,
            reachedBy: `Tab: ${tab.label}`,
            depth: next.depth,
            screenshot: tabShotPath,
            issues: tabIssues,
          });
          ctx.onLog(`[Navigation]   ↳ tab "${tab.label}" — ${tabIssues.length === 0 ? 'no issues' : tabIssues.join('; ')}`);
        }
      }

      // Only discover deeper nav from authenticated pages (has content, no login wall)
      const hasPasswordInput = (await page.locator('input[type="password"]').count()) > 0;
      if (!hasPasswordInput && next.depth < MAX_DEPTH) {
        const childItems = await collectNavItems(page, baseOrigin);
        for (const child of childItems) {
          if (child.href && visitedUrls.has(child.href)) continue;
          if (!child.href && visitedKeys.has(`${finalUrl}::${child.label}`)) continue;
          queue.push({
            url: child.href,
            label: child.label,
            depth: next.depth + 1,
            selector: child.selector,
            discoveredOnUrl: finalUrl,
          });
        }
      }

    } catch (err) {
      const message = (err as Error).message;
      // §2 — infinite redirect loop. The browser engine itself detects and aborts this
      // (ERR_TOO_MANY_REDIRECTS/NS_ERROR_REDIRECT_LOOP) rather than hanging — this just turns
      // that specific failure into a distinct, actionable finding instead of a generic,
      // easy-to-miss nav-failure log line indistinguishable from a timeout or a typo'd link.
      if (/too many redirects|redirect_loop|ERR_TOO_MANY_REDIRECTS/i.test(message) && next.url) {
        ctx.onFinding({
          severity: 'high',
          area: 'Navigation',
          title: 'Infinite redirect loop',
          steps: [`Navigate to "${next.label}" (${next.url})`],
          expected: 'The page loads without redirecting indefinitely',
          actual: `The browser aborted navigation after detecting a redirect loop: ${message}`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: next.url,
          confidence: 'verified',
          confidenceReason: 'The browser engine itself detected and reported the redirect loop — not inferred from a timeout.',
        });
      }
      ctx.onLog(`[Navigation] Failed to visit "${next.label}": ${message}`);
    }
  }

  // ── Report JS console errors collected across all pages ──────────────────
  const uniqueJsErrors = [...new Set(jsErrors)];
  if (uniqueJsErrors.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Navigation',
      title: `JavaScript console errors detected during site traversal (${uniqueJsErrors.length})`,
      steps: ['Navigate through all discovered pages', 'Monitor browser console'],
      expected: 'No JavaScript errors in console',
      actual: uniqueJsErrors.slice(0, 5).join('\n'),
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  // ── Share discovered API endpoints with the API executor ────────────────
  // This is the key handoff: real endpoints from the authenticated app's network
  // traffic replace generic guesses (/api/users, /api/admin) in API tests.
  if (capturedApiEndpoints.size > 0) {
    const endpoints = [...capturedApiEndpoints];
    // Merge with any endpoints already found by recon (login-phase calls)
    const existing = new Set(ctx.discoveredApiEndpoints ?? []);
    for (const e of endpoints) existing.add(e);
    ctx.discoveredApiEndpoints = [...existing];
    ctx.onLog(
      `[Navigation] Captured ${endpoints.length} real API endpoints from authenticated app — ` +
      `total available for API executor: ${ctx.discoveredApiEndpoints.length}`,
    );
    // Log a sample so the user can see what was discovered
    endpoints.slice(0, 5).forEach((e) => ctx.onLog(`[Navigation]   → ${e}`));
  } else {
    ctx.onLog('[Navigation] No XHR/fetch API calls captured during traversal');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  ctx.onLog(
    `[Navigation] Traversal complete — visited ${visitedPages.length} pages, ` +
    `found ${visitedPages.filter((p) => p.issues.length > 0).length} with issues, ` +
    `${uniqueJsErrors.length} JS errors`,
  );

  // Return to start
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
}
