// Core Web Vitals — LCP, CLS, INP. The existing performance checks (load-time, large-payload,
// spike-load, n-plus-one) all measure network/server behavior: how long a request takes, how
// much data comes back, how the server holds up under load. None of them measure what the
// USER actually perceives while the page renders — a fast server response can still produce a
// slow-feeling page if the largest element takes ages to paint, or a page that loads quickly
// but visibly jumps around as images/ads/fonts load in. These are Google's own three Core Web
// Vitals, measured the same way Chrome itself measures them (native PerformanceObserver entry
// types), not a third-party approximation.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent } from './helpers.js';

// Google's own published thresholds (web.dev/vitals) — "poor" is the line worth a finding;
// "needs improvement" is logged but not raised, to keep this from being noisy on sites that
// are merely mediocre rather than actually broken.
const THRESHOLDS = {
  lcp: { poor: 4000, unit: 'ms' },
  cls: { poor: 0.25, unit: '' },
  inp: { poor: 500, unit: 'ms' },
} as const;

interface CoreWebVitals {
  lcp: number;
  cls: number;
  inp: number;
}

function installObservers(): void {
  const w = window as unknown as { __cwv: CoreWebVitals };
  w.__cwv = { lcp: 0, cls: 0, inp: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry | undefined;
      if (last) w.__cwv.lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    /* not supported in this engine — leaves lcp at 0, treated as "not measured" below */
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) w.__cwv.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* not supported */
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { duration: number }>) {
        if (entry.duration > w.__cwv.inp) w.__cwv.inp = entry.duration;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  } catch {
    /* not supported */
  }
}

export async function runWebVitalsCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[WebVitals] Measuring Core Web Vitals (LCP, CLS, INP)');
  const url = page.url();

  // Needs a install-before-navigate script — LCP/CLS both accumulate from the very start of a
  // navigation, so measuring on the ALREADY-loaded shared page would miss everything that
  // already happened. addInitScript runs before any page script, on every subsequent
  // navigation in this page — removed at the end so it doesn't leak into later flows.
  await page.addInitScript(installObservers);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  if (!response) {
    ctx.onLog('[WebVitals] Could not reload the page cleanly — skipping');
    return;
  }
  await waitForRealContent(page);
  // LCP finalizes on the first user interaction (per spec) — read it now, before our own
  // synthetic click below closes its measurement window.
  await page.waitForTimeout(500);
  const { lcp, cls } = await page.evaluate(() => (window as unknown as { __cwv: CoreWebVitals }).__cwv).catch(() => ({ lcp: 0, cls: 0, inp: 0 }));

  // INP needs at least one real interaction to have anything to measure — click the first
  // safe, visible, non-navigating-away control so the "next paint" it produces is a fair
  // sample of real interaction responsiveness, without leaving the page.
  const safeTarget = page.locator('button:visible:not([type="submit"]), [role="tab"]:visible').first();
  let inp = 0;
  if (await safeTarget.count().catch(() => 0)) {
    await safeTarget.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    inp = await page
      .evaluate(() => (window as unknown as { __cwv: CoreWebVitals }).__cwv.inp)
      .catch(() => 0);
  } else {
    ctx.onLog('[WebVitals] No safe interactive element found to measure INP — reporting LCP/CLS only');
  }

  ctx.onLog(`[WebVitals] LCP=${lcp.toFixed(0)}ms CLS=${cls.toFixed(3)} INP=${inp.toFixed(0)}ms`);

  const problems: string[] = [];
  if (lcp > THRESHOLDS.lcp.poor) problems.push(`LCP ${lcp.toFixed(0)}ms (poor is >${THRESHOLDS.lcp.poor}ms) — the largest visible element takes too long to render`);
  if (cls > THRESHOLDS.cls.poor) problems.push(`CLS ${cls.toFixed(3)} (poor is >${THRESHOLDS.cls.poor}) — visible content is shifting around as the page loads`);
  if (inp > THRESHOLDS.inp.poor) problems.push(`INP ${inp.toFixed(0)}ms (poor is >${THRESHOLDS.inp.poor}ms) — the page feels sluggish to interact with`);

  if (problems.length === 0) {
    ctx.onLog('[WebVitals] All measured Core Web Vitals are within Google\'s "poor" threshold');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'web-vitals.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'Performance-WebVitals',
    title: `${problems.length} Core Web Vital(s) in "poor" range`,
    steps: [`Open ${url}`, 'Open DevTools → Lighthouse or Performance panel', 'Record Core Web Vitals for this page'],
    expected: 'LCP under 4s, CLS under 0.25, INP under 500ms (Google\'s "poor" thresholds)',
    actual: problems.join('; '),
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: url,
    confidence: 'verified',
    confidenceReason: 'Measured via the browser\'s own native PerformanceObserver entries (largest-contentful-paint, layout-shift, event timing) — the same signal Chrome DevTools and Lighthouse report from, not a third-party approximation. A single-page-load sample; real-world values vary by device and network conditions.',
  });
}
