// A6 — Scroll & viewport: mobile size, zoom, sticky headers
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage, explorationBreadth } from './helpers.js';
import { matchesKnownNonBugPattern } from './non-bug-patterns.js';

// Ordered smallest-value-first within each tier's additions — sliced by depth, so smoke
// keeps the original 3-size baseline and deeper runs add genuinely distinct breakpoints
// rather than just more of the same rough size.
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 720 },
  // Smallest common real screen — layouts tuned only for 375px often still break here.
  { name: 'small-mobile', width: 320, height: 568 },
  // A big monitor is not just "desktop but wider" — content can look sparse/misaligned
  // when a layout's max-width assumptions are wrong, which 1280px alone won't surface.
  { name: 'large-desktop', width: 1920, height: 1080 },
  // Bootstrap-style CSS breakpoint edges — media-query off-by-one bugs (a layout that
  // shifts one pixel before or after the intended threshold) only show up AT the edge,
  // not at round numbers like 375/768/1280 that happen to sit comfortably inside a range.
  { name: 'breakpoint-576', width: 576, height: 900 },
  { name: 'breakpoint-992', width: 992, height: 900 },
  { name: 'breakpoint-1200', width: 1200, height: 900 },
  { name: 'ultra-wide', width: 2560, height: 1440 },
];

export async function runViewport(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Viewport] Testing responsive layout at multiple screen sizes');

  const viewportCount = explorationBreadth(ctx, { smoke: 3, standard: 5, deep: VIEWPORTS.length, chaos: 3 });
  const activeViewports = VIEWPORTS.slice(0, viewportCount);

  for (const vp of activeViewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });

    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      // A failed/timed-out reload leaves the page blank or stale — measuring overflow or
      // nav visibility against that would report false "no overflow" / "no nav" findings
      // that are really just symptoms of the page never loading, not real UX bugs.
      ctx.onLog(
        `[Viewport] ${vp.name}: page failed to reload (${(err as Error).message.slice(0, 100)}) — skipping checks at this size`,
      );
      continue;
    }

    // 'domcontentloaded' fires before client-rendered apps (Vue/React/Angular) finish
    // mounting — a successful reload can still leave the page blank moments later. Poll
    // for real rendered content instead of trusting a flat wait to be long enough.
    const contentDeadline = Date.now() + 5000;
    let hasContent = false;
    let bodyText = '';
    while (Date.now() < contentDeadline) {
      bodyText = await page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
      hasContent = bodyText.length > 100;
      if (hasContent) break;
      await page.waitForTimeout(300);
    }
    if (!hasContent) {
      // A real mobile-width viewport commonly triggers the SAME "please download our app"
      // gate device-matrix.ts already recognizes — that page is short (often under 100 chars)
      // by design, not a failed render. Calling it "blank" mislabels a legitimate state as a
      // check failure and, worse, silently skips the overflow check on exactly the sizes
      // (mobile/small-mobile) most likely to actually need it.
      const nonBug = matchesKnownNonBugPattern(bodyText);
      if (nonBug) {
        ctx.onLog(`[Viewport] ${vp.name}: shows a "${nonBug}" (${bodyText.length} chars) instead of the usual page — matches a known legitimate pattern, not a failed render`);
      } else {
        ctx.onLog(`[Viewport] ${vp.name}: page still blank after reload (${bodyText.length} chars) — skipping checks at this size`);
      }
      continue;
    }

    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `viewport-${vp.name}.png`);
    await page.screenshot({ path: shot, fullPage: false });

    // Check for horizontal overflow (content wider than viewport)
    const hasOverflow = await page.evaluate((w) => {
      return document.documentElement.scrollWidth > w;
    }, vp.width);

    if (hasOverflow) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Viewport',
        title: `Horizontal overflow at ${vp.name} (${vp.width}px)`,
        steps: [`Set viewport to ${vp.width}×${vp.height}`, 'Reload page', 'Check scrollWidth'],
        expected: 'No horizontal scroll at any viewport size',
        actual: `Content overflows horizontally at ${vp.width}px`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }

    // Check nav is accessible (not hidden / collapsed and unreachable).
    // Skip this check on login/auth-wall pages — they intentionally have no app navigation.
    const onLoginWall = await isLoginWallPage(page);
    const navEl = page.locator('nav, [role="navigation"]').first();
    const navExists = (await navEl.count()) > 0;
    const navVisible = navExists ? await navEl.isVisible().catch(() => false) : false;

    if (!navVisible && !onLoginWall) {
      // Check for hamburger / drawer trigger — apps use many different patterns:
      // named classes (.bm-burger-button, .hamburger, .menu-toggle, .nav-toggle),
      // aria labels, SVG icon buttons, or small clickable divs in the header.
      const hamburgerSelector = [
        '[aria-label*="menu" i]',
        '[aria-label*="navigation" i]',
        '[aria-label*="hamburger" i]',
        '[aria-expanded]',          // disclosure buttons (accordion / drawer)
        '[class*="burger"]',        // React Burger Menu, custom
        '[class*="hamburger"]',
        '[class*="menu-toggle"]',
        '[class*="nav-toggle"]',
        '[class*="menu-btn"]',
        '[class*="sidebar-toggle"]',
        'button:has(svg)',          // icon-only buttons
        '.menu-toggle',
        '.nav-toggle',
        '.hamburger',
      ].join(', ');

      const hamburgerVisible = await page
        .locator(hamburgerSelector)
        .first()
        .isVisible()
        .catch(() => false);

      // Final fallback: any small clickable element (≤ 60×60px) in the top 80px
      // of the page — typical for hamburger triggers that use generic div/span.
      const smallTopClickable = !hamburgerVisible && await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('header *, [class*="header"] *, [class*="top-bar"] *'));
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (
            r.top < 80 && r.width > 0 && r.width <= 60 && r.height > 0 && r.height <= 60 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            (el.tagName === 'BUTTON' || el.tagName === 'A' ||
              style.cursor === 'pointer' || (el as HTMLElement).onclick !== null)
          ) {
            return true;
          }
        }
        return false;
      }).catch(() => false);

      // Third fallback: a persistent, already-expanded sidebar. At tablet/desktop widths,
      // dashboards commonly show the full nav directly (no hamburger needed — there's
      // room), so a check that only looks for a semantic <nav>, a hamburger trigger, or a
      // small header button misses it entirely and flags a real, visible sidebar as "no
      // navigation found." This check is deliberately NOT tag/class-name based — plenty of
      // real sites (Tailwind-styled apps especially) use bare utility classes like
      // "flex items-center gap-3 px-4 py-3" with zero semantic naming, so `aside` /
      // `[class*="sidebar"]` matches nothing even though a real, visible nav list is right
      // there. Instead this looks for what a sidebar actually LOOKS like: 3+ distinct
      // internal links stacked vertically at roughly the same horizontal position.
      const sidebarNavVisible = !hamburgerVisible && !smallTopClickable && await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]')).filter((el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        const columns = new Map<number, number>(); // rounded left-x -> count at that x
        for (const el of links) {
          const x = Math.round(el.getBoundingClientRect().left / 10) * 10; // bucket to nearest 10px
          columns.set(x, (columns.get(x) ?? 0) + 1);
        }
        return [...columns.values()].some((count) => count >= 3);
      }).catch(() => false);

      if (!hamburgerVisible && !smallTopClickable && !sidebarNavVisible) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Viewport',
          title: `Navigation not visible at ${vp.name} size`,
          steps: [`Set viewport to ${vp.width}×${vp.height}`, 'Reload page', 'Check nav / hamburger visibility'],
          expected: 'Navigation element or hamburger menu trigger accessible at all screen sizes',
          actual: `No nav, [role="navigation"], hamburger trigger, or expanded sidebar found at ${vp.width}px`,
          evidence: [shot],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        const via = hamburgerVisible ? 'hamburger trigger' : smallTopClickable ? 'small header button' : 'expanded sidebar';
        ctx.onLog(`[Viewport] ${vp.name}: nav accessible via ${via} — OK`);
      }
    } else if (!navVisible && onLoginWall) {
      ctx.onLog(`[Viewport] ${vp.name}: no nav on login wall — expected, skipping finding`);
    }

    ctx.onLog(`[Viewport] ${vp.name} (${vp.width}px): overflow=${hasOverflow}, nav=${navVisible ? 'visible' : (onLoginWall ? 'N/A (login wall)' : 'hidden')}`);
  }

  // Restore desktop
  await page.setViewportSize({ width: 1280, height: 720 });
}
