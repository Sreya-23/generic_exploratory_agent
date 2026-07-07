import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

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
const NAV_CLICK_SELECTORS = [
  // Hamburger / drawer triggers (must click to reveal hidden menu)
  '[class*="burger"]',
  '[class*="hamburger"]',
  '[class*="menu-toggle"]',
  '[class*="nav-toggle"]',
  '[aria-label*="menu" i]',
  '[aria-label*="open navigation" i]',
  // Sidebar nav items
  '[class*="sidebar"] a[href]',
  '[class*="side-nav"] a[href]',
  '[class*="side-menu"] a[href]',
  '[class*="drawer"] a[href]',
  // Top-nav / header links
  'nav a[href]',
  'header a[href]',
  '[role="navigation"] a[href]',
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
  '[class*="nav-item"] a[href]',
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
  const items: NavItem[] = [];
  const seen = new Set<string>();

  // First reveal any hidden panels
  await revealHiddenNav(page);
  await page.waitForTimeout(300);

  for (const sel of NAV_CLICK_SELECTORS) {
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

  // Look for visible error text
  const errorText = await page.locator('[class*="error"]:visible, [role="alert"]:visible').first()
    .textContent().catch(() => null);
  if (errorText?.trim()) {
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
  const visitedPages: NavPage[] = [];
  const queue: Array<{ url: string | null; label: string; depth: number }> = [];

  // Collect initial nav from the landing/post-login page
  const initialItems = await collectNavItems(page, baseOrigin);
  ctx.onLog(`[Navigation] Discovered ${initialItems.length} nav items on entry page`);

  for (const item of initialItems) {
    queue.push({ url: item.href, label: item.label, depth: 1 });
  }

  // BFS — visit each discovered page, then discover its nav items
  const MAX_PAGES = 25;
  const MAX_DEPTH = 3;

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
    if (!next.url || visitedUrls.has(next.url)) continue;

    visitedUrls.add(next.url);

    ctx.onLog(`[Navigation] Visiting [depth ${next.depth}]: "${next.label}" → ${next.url}`);

    try {
      const response = await page.goto(next.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(500);

      const httpStatus = response?.status() ?? 0;
      const pageTitle = await page.title().catch(() => '');
      const finalUrl = page.url();

      const shotName = `nav-${visitedPages.length}-${next.label.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`;
      const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${shotName}.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

      const pageIssues = await auditPage(page);

      // HTTP error check
      if (httpStatus >= 400) {
        pageIssues.push(`HTTP ${httpStatus}`);
        ctx.onFinding({
          severity: httpStatus >= 500 ? 'high' : 'medium',
          area: 'UI-Navigation',
          title: `Broken link: "${next.label}" returns HTTP ${httpStatus}`,
          steps: [
            `Navigate to: ${next.url}`,
            `Link reached via: "${next.label}"`,
          ],
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
          steps: [`Navigate to ${next.url}`, 'Inspect page content'],
          expected: 'Page renders correctly with content',
          actual: issue,
          evidence: [shotPath],
          reproRate: '1/1',
          automationCandidate: true,
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
          if (!child.href || visitedUrls.has(child.href)) continue;
          queue.push({ url: child.href, label: child.label, depth: next.depth + 1 });
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
