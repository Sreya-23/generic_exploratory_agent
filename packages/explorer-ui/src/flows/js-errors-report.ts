import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { getTrackedErrors, clearTrackedErrors } from './js-error-tracker.js';

// SVG geometry attributes (r, transform, d, width/height) rejecting NaN/negative values are
// the textbook signature of a charting library (Recharts/D3/etc.) computing pixel geometry
// from a container that hasn't been laid out yet — it fires in the split-second right after
// mount, before a resize observer settles the real width. Confirmed against a real dashboard
// this session: reported by the automated check (a fresh page load that happens to land right
// in that window), reported as "cannot reproduce" on a manual re-check moments later. The
// error is genuinely real (not fabricated), but "verified" here means "the browser really
// emitted this," not "will reproduce on every visit" — worth an honest caveat rather than
// implying it's a persistent, always-on defect.
// Matches on the STRUCTURE (an SVG geometry attribute rejecting a malformed number/length),
// not the specific malformed value — "NaN", a negative radius, and a scientific-notation
// precision artifact ("...499999999999995 e-16...") are all the same underlying symptom of
// a chart computing geometry before its container is sized, just with different floating-point
// noise depending on exactly when it fired.
const SVG_TIMING_RACE_PATTERN =
  /<(circle|path|rect|line|g|svg|foreignObject|ellipse|polygon|polyline)>\s*attribute\s+(r|rx|ry|transform|d|width|height|x|y|cx|cy):\s*(Expected (number|length)|A negative value is not valid)/i;

function isLikelyChartTimingRace(message: string): boolean {
  return SVG_TIMING_RACE_PATTERN.test(message);
}

// Runs late in the plan (report phase) so it reports everything accumulated across the WHOLE
// session — every task's page gets its own browser context, but js-error-tracker.ts's
// module-level store is keyed by sessionId, so errors from every earlier task are still here.
export async function runJsErrorsReport(
  _page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const errors = getTrackedErrors(ctx.sessionId);
  if (errors.length === 0) {
    ctx.onLog('[JsErrors] No uncaught JS errors or console errors observed across the session');
    return;
  }

  ctx.onLog(`[JsErrors] ${errors.length} unique JS error(s) observed across the session`);

  // Chart-timing-race errors on the SAME page are one underlying defect (the chart computes
  // geometry before its container is sized), not several distinct ones — different specific
  // SVG attributes fail depending on exactly when the race fires, which is floating-point/
  // timing noise, not meaningfully different bugs. Reporting one per raw message produced
  // several near-identical low-severity findings with IDENTICAL repro steps (same page, same
  // "open DevTools console"), which read as noise rather than as N separate things to fix —
  // confirmed real user confusion: "steps to reproduce are the same [across all of them]".
  // Grouping by page consolidates them into one finding that names the actual root cause,
  // with the individual raw console messages kept as supporting detail underneath.
  const chartRaceByUrl = new Map<string, typeof errors>();
  const individual: typeof errors = [];
  for (const e of errors.slice(0, 30)) {
    if (isLikelyChartTimingRace(e.message)) {
      const list = chartRaceByUrl.get(e.url) ?? [];
      list.push(e);
      chartRaceByUrl.set(e.url, list);
    } else {
      individual.push(e);
    }
  }

  for (const e of individual.slice(0, 15)) {
    // Not all console activity carries the same weight. An 'uncaught exception' (Playwright's
    // pageerror — real application code threw and nothing caught it, e.g. a TypeError in a
    // query function) is a genuine crash in logic and worth real attention. A plain
    // 'console.error' for a failed resource load (a blocked third-party script, an analytics
    // beacon, a 403 on something that may be intentionally gated) is a much weaker signal on
    // its own — it might not reflect a real application bug at all. Treating both the same
    // flattens exactly the distinction that determines whether this is worth a developer's
    // time.
    const isResourceLoadFailure = /failed to load resource/i.test(e.message);
    // Confirmed against a real run (amazon.in): a Content-Security-Policy violation for a
    // third-party ad/tracking domain is near-always either intentional CSP enforcement doing
    // its job, or the ad network's own resource being blocked — not a defect in the site being
    // tested. Same weak-signal reasoning as a resource-load failure, not the "medium" every
    // other console.error gets by default.
    const isCspViolation = /violates the following content security policy directive/i.test(e.message);
    const severity =
      e.source === 'uncaught exception' ? 'high' : isResourceLoadFailure || isCspViolation ? 'low' : 'medium';
    ctx.onFinding({
      severity,
      area: 'UI-JsError',
      title: `JS error: ${e.message}`,
      steps: [`Open ${e.url}`, 'Open browser DevTools → Console'],
      expected: 'No uncaught JavaScript errors during normal use',
      actual: `${e.source}: ${e.message}`,
      evidence: e.screenshotPath ? [e.screenshotPath] : [],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: e.url,
      confidence: 'verified',
      confidenceReason: 'Captured directly from the browser\'s own pageerror/console.error events, not inferred.',
    });
  }

  for (const [url, group] of chartRaceByUrl) {
    const distinctMessages = [...new Set(group.map((g) => g.message))];
    const screenshot = group.find((g) => g.screenshotPath)?.screenshotPath;
    const explanation =
      'A charting component (Recharts/D3-style SVG chart) computed its geometry — radius, ' +
      'width, position — before its container had real layout dimensions, producing invalid ' +
      'values like NaN or a negative radius. This is a rendering-order race in the chart ' +
      "library's mount sequence, not a data or logic bug, and typically self-corrects on the " +
      'next render once the container is measured.';
    ctx.onFinding({
      severity: 'low',
      area: 'UI-JsError',
      title: `JS error: SVG chart rendered before its container was sized (${distinctMessages.length} related console error${distinctMessages.length > 1 ? 's' : ''})`,
      steps: [`Open ${url}`, 'Open browser DevTools → Console', 'Watch the console during the chart\'s initial render'],
      expected: 'No uncaught JavaScript errors during normal use',
      actual:
        `${explanation}\n\nRaw console messages observed:\n` +
        distinctMessages.map((m) => `• ${m}`).join('\n'),
      evidence: screenshot ? [screenshot] : [],
      reproRate: 'Intermittent — caught during initial chart render, may not appear on every page load',
      automationCandidate: true,
      pageUrl: url,
      confidence: 'verified',
      confidenceReason:
        'Each raw message was captured directly from the browser\'s own console.error events — genuinely thrown, not inferred. Consolidated into one finding because all of them share the same root cause (see Actual) and would otherwise read as several near-identical low-severity findings with the same repro steps.',
    });
  }

  clearTrackedErrors(ctx.sessionId);
}
