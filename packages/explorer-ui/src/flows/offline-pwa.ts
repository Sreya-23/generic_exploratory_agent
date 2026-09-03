// Service worker / PWA offline behavior — distinct from chaos/flaky-network.ts, which
// simulates a degraded connection by aborting a percentage of requests while the network
// itself stays "up". This tests the real thing a service worker is supposed to provide: does
// the page still show something meaningful with the network fully cut, via context.setOffline
// (a genuine OS/browser-level offline state, not per-request interception). Sites that don't
// register a service worker at all are simply not attempting to be offline-capable — that's
// not a defect, so this only raises a finding for a site that HAS one but doesn't actually use
// it for offline access, which is the "claims to be a PWA but isn't really" gap.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent } from './helpers.js';

export async function runOfflinePwaCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[OfflinePwa] Checking for a service worker and real offline-cache behavior');
  const url = page.url();

  const hasServiceWorker = await page
    .evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    })
    .catch(() => false);

  if (!hasServiceWorker) {
    ctx.onLog('[OfflinePwa] No service worker registered — not a PWA, skipping offline-cache check');
    return;
  }

  // Give an active-but-still-installing worker a moment to reach "ready" before testing —
  // otherwise a freshly-registered worker that hasn't finished its install/activate cycle
  // would be judged on a cache it hasn't populated yet.
  await page
    .evaluate(() => navigator.serviceWorker.ready.then(() => true))
    .catch(() => false);
  await page.waitForTimeout(500);

  const context = page.context();
  try {
    await context.setOffline(true);
    const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);

    if (!response) {
      const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'offline-pwa.png');
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      ctx.onFinding({
        severity: 'low',
        area: 'UI-OfflinePwa',
        title: 'Service worker is registered but the page fails to load fully offline',
        steps: [
          `Open ${url} once online (so the service worker installs)`,
          'Turn off network access entirely',
          'Reload the page',
        ],
        expected: 'A registered service worker should serve a cached version of the page (or a deliberate offline fallback) rather than failing to load at all',
        actual: 'The reload did not complete while offline — the service worker does not appear to be caching this page for offline access',
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
        confidence: 'verified',
        confidenceReason: 'Offline was simulated via a genuine browser-level network cutoff (context.setOffline), not per-request interception — this reflects what a real user with no signal would see.',
      });
      return;
    }

    await waitForRealContent(page).catch(() => {});
    const bodyLength = await page
      .evaluate(() => (document.body?.innerText ?? '').trim().length)
      .catch(() => 0);

    if (bodyLength < 40) {
      const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'offline-pwa-blank.png');
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      ctx.onFinding({
        severity: 'low',
        area: 'UI-OfflinePwa',
        title: 'Service worker is registered but offline reload shows an essentially blank page',
        steps: [
          `Open ${url} once online (so the service worker installs)`,
          'Turn off network access entirely',
          'Reload the page',
        ],
        expected: 'A cached, meaningful version of the page (or a clear "you\'re offline" screen) should render',
        actual: `Offline reload rendered only ${bodyLength} character(s) of visible text — effectively blank`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
        confidence: 'heuristic',
        confidenceReason: 'A short but deliberate "you appear to be offline" message would also produce a small character count — check the attached screenshot to distinguish a genuinely broken offline state from a legitimate, minimal offline notice.',
      });
    } else {
      ctx.onLog(`[OfflinePwa] Page rendered ${bodyLength} characters of content while offline — service worker caching appears functional`);
    }
  } finally {
    // Critical cleanup — leaving the context offline would break every check that runs after
    // this one for the rest of the session.
    await context.setOffline(false).catch(() => {});
  }
}
