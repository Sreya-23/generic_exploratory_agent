// A6 — Scroll & viewport: mobile size, zoom, sticky headers
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 720 },
];

export async function runViewport(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Viewport] Testing responsive layout at multiple screen sizes');

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);

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

      if (!hamburgerVisible && !smallTopClickable) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Viewport',
          title: `Navigation not visible at ${vp.name} size`,
          steps: [`Set viewport to ${vp.width}×${vp.height}`, 'Reload page', 'Check nav / hamburger visibility'],
          expected: 'Navigation element or hamburger menu trigger accessible at all screen sizes',
          actual: `No nav, [role="navigation"], or hamburger trigger found at ${vp.width}px`,
          evidence: [shot],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        ctx.onLog(`[Viewport] ${vp.name}: nav accessible via ${hamburgerVisible ? 'hamburger trigger' : 'small header button'} — OK`);
      }
    } else if (!navVisible && onLoginWall) {
      ctx.onLog(`[Viewport] ${vp.name}: no nav on login wall — expected, skipping finding`);
    }

    ctx.onLog(`[Viewport] ${vp.name} (${vp.width}px): overflow=${hasOverflow}, nav=${navVisible ? 'visible' : (onLoginWall ? 'N/A (login wall)' : 'hidden')}`);
  }

  // Restore desktop
  await page.setViewportSize({ width: 1280, height: 720 });
}
