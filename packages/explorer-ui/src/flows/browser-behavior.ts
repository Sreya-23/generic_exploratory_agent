import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

/**
 * Checklist (UI) §25 — Browser Behaviour: Popups and Browser Permissions. Previously zero code
 * anywhere in explorer-ui touched either of these — confirmed via grep across all flow files.
 * Also closes part of §1's "open links in a new tab" (a target="_blank" link IS a popup from
 * Playwright's perspective — the 'popup' event fires for both window.open() and target="_blank"
 * navigation).
 */
export async function runBrowserBehaviorCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[BrowserBehavior] Login wall detected — skipping');
    return;
  }

  // ── Popups / new-tab links ────────────────────────────────────────────────────────────────
  const newTabLink = page.locator('a[target="_blank"]:visible').first();
  if ((await newTabLink.count()) > 0) {
    try {
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 4000 }),
        newTabLink.click(),
      ]);
      await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const popupUrl = popup.url();
      if (!popupUrl || popupUrl === 'about:blank') {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-BrowserBehavior',
          title: 'target="_blank" link opens a blank/empty tab',
          steps: ['Click a link with target="_blank"'],
          expected: 'The new tab should load the linked destination',
          actual: `New tab opened with URL: "${popupUrl || '(empty)'}"`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
          confidence: 'heuristic',
          confidenceReason: 'The destination may still be loading asynchronously (e.g. a client-side redirect) — verify before treating as confirmed.',
        });
      } else {
        ctx.onLog(`[BrowserBehavior] target="_blank" link correctly opened a new tab: ${popupUrl}`);
      }
      await popup.close().catch(() => {});
    } catch {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-BrowserBehavior',
        title: 'target="_blank" link does not actually open a new tab',
        steps: ['Click a link with target="_blank"'],
        expected: 'A new browser tab/window should open',
        actual: 'No new page/popup event fired within 4s of clicking',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'A click handler may have intercepted and suppressed default navigation for a legitimate reason (e.g. showing a modal instead) — verify before treating as confirmed.',
      });
    }
  } else {
    ctx.onLog('[BrowserBehavior] No target="_blank" links found — skipping new-tab/popup check');
  }

  // ── Browser permissions (geolocation / notifications) ────────────────────────────────────
  // Playwright's browser context auto-denies permission prompts by default (no real native
  // dialog blocks the test) — the genuinely checkable question is whether the PAGE handles that
  // denial gracefully (shows a fallback/explanation) rather than hanging indefinitely or
  // throwing an unhandled error waiting for a response that will never arrive as "granted".
  const permissionTrigger = page.locator(
    'button:has-text("location"), button:has-text("Enable notifications"), button:has-text("Allow location"), button:has-text("Share location"), button:has-text("Notify me")',
  ).first();
  if ((await permissionTrigger.count()) > 0) {
    const consoleErrors: string[] = [];
    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    };
    page.on('console', onConsole);
    try {
      await permissionTrigger.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const stillResponsive = await page.evaluate(() => document.readyState).catch(() => null);
      if (stillResponsive === null) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-BrowserBehavior',
          title: 'Page becomes unresponsive after a denied permission request',
          steps: ['Click a control that requests a browser permission (location/notifications)', 'Permission is auto-denied'],
          expected: 'The page should remain responsive and show a graceful fallback after a permission is denied',
          actual: 'Page did not respond to a basic script evaluation after the permission request',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
        });
      } else {
        ctx.onLog('[BrowserBehavior] Page remains responsive after a denied permission request');
      }
      if (consoleErrors.length > 0) {
        ctx.onLog(`[BrowserBehavior] ${consoleErrors.length} console error(s) logged after the permission request — see js-errors check for details`);
      }
    } finally {
      page.off('console', onConsole);
    }
  } else {
    ctx.onLog('[BrowserBehavior] No permission-requesting control (location/notifications) found — skipping');
  }
}
