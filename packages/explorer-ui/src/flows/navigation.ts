import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { findVisibleErrorText, explorationBreadth } from './helpers.js';

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
        await target.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(800);
      }

      const pageTitle = await page.title().catch(() => '');
      const finalUrl = page.url();
      visitedUrls.add(finalUrl);

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
      ctx.onLog(`[Navigation] Failed to visit "${next.label}": ${(err as Error).message}`);
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
