import { isUrlInScope } from './helpers.js';
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


// Checks that disrupt the app ON PURPOSE. An error that only fired while one of these was
// running (login wiped, network cut, extreme input typed) is a reaction to the agent's own
// tampering — users would not normally hit it, and a person re-testing by hand won't see it.
const DISRUPTIVE_CHECKS: Array<{ test: RegExp; what: string }> = [
  {
    test: /^(session-timeout|multi-tab-logout|logout-session|session-expires-mid-op|deep-link|hidden-route-access|token-refresh|forgot-password)$/,
    what: 'deliberately clearing or ending the login session',
  },
  {
    test: /^(slow-network|offline-mid-request|offline-recovery|offline-pwa|flaky-network|timeout-retry|websocket-disconnect|cpu-throttle|back-during-post|refresh-during-request|cancel-during-loading|navigate-away-during-loading|double-submit|interruption|bfcache|forward-after-back)$/,
    what: 'deliberately cutting, slowing or interrupting the page while it loaded',
  },
  {
    test: /^(input-boundary|malformed-input|business-logic-boundary|boundary|long-content|field-validation|form-validation|concurrent-edit)$/,
    what: 'deliberately entering extreme or invalid input',
  },
  { test: /^(double-click)$/, what: 'deliberately clicking the same button many times very fast' },
  {
    test: /^(rtl-layout|dark-mode|zoom-reflow|locale-format|reduced-motion|element-overflow|cross-browser|device-matrix|viewport)$/,
    what: 'changing the page\'s direction, theme, zoom, language or screen size',
  },
];

function disruptionOf(flow?: string): string | null {
  if (!flow) return null;
  return DISRUPTIVE_CHECKS.find((d) => d.test.test(flow))?.what ?? null;
}

const errKey = (m: string) => m.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * Re-opens each page where first-party errors were seen, in a clean logged-in page, and
 * records which errors fire again on a plain visit. This is what a person re-testing by hand
 * does — and an error that doesn't come back on a normal visit shouldn't be reported as if
 * it always happens.
 */
async function recheckPages(page: Page, ctx: ExecutorContext, urls: string[]): Promise<Map<string, Set<string>>> {
  const seen = new Map<string, Set<string>>();
  for (const url of urls) {
    const keys = new Set<string>();
    const onErr = (err: Error) => keys.add(errKey(err.message));
    const onConsole = (msg: { type(): string; text(): string }) => {
      if (msg.type() === 'error') keys.add(errKey(msg.text()));
    };
    page.on('pageerror', onErr);
    page.on('console', onConsole);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      seen.set(url, keys);
      ctx.onLog(`[JsErrors] Re-visited ${url} — ${keys.size} console error(s) on a plain visit`);
    } catch {
      ctx.onLog(`[JsErrors] Could not re-open ${url} to re-check its errors`);
    } finally {
      page.off('pageerror', onErr);
      page.off('console', onConsole);
    }
  }
  return seen;
}

const MAX_RECHECK_PAGES = 6;

// Runs late in the plan (report phase) so it reports everything accumulated across the WHOLE
// session — every task's page gets its own browser context, but js-error-tracker.ts's
// module-level store is keyed by sessionId, so errors from every earlier task are still here.
export async function runJsErrorsReport(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  // Errors raised on another company's site (a link the agent followed opened it in a new tab —
  // e.g. OrangeHRM's "Upgrade" → orangehrm.com) are not this app's bugs, and errors on pages
  // outside the user's allowed sections are not what they asked about.
  const siteOf = (u: string) => {
    try {
      return new URL(u).hostname.split('.').slice(-2).join('.');
    } catch {
      return '';
    }
  };
  const targetSite = siteOf(ctx.config.targetUrl);
  const allErrors = getTrackedErrors(ctx.sessionId);
  const errors = allErrors.filter(
    (e) =>
      siteOf(e.url) === targetSite &&
      (!ctx.config.allowedSections?.length || isUrlInScope(e.url, ctx.config.allowedSections)),
  );
  if (errors.length < allErrors.length) {
    ctx.onLog(`[JsErrors] ${allErrors.length - errors.length} error(s) left out — raised on another site or outside the allowed sections`);
  }
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

  // Re-check first-party errors on a plain visit (third-party/vendor failures aren't the
  // app's bug either way, so they're not worth the time).
  const firstPartyUrl = (e: (typeof errors)[number]) => {
    if (!e.resourceUrl) return true;
    try {
      const pageHost = new URL(e.url).hostname.split('.').slice(-2).join('.');
      return new URL(e.resourceUrl).hostname.endsWith(pageHost);
    } catch {
      return true;
    }
  };
  const urlsToRecheck = [
    ...new Set([...individual.filter(firstPartyUrl), ...[...chartRaceByUrl.values()].flat()].map((e) => e.url)),
  ].slice(0, MAX_RECHECK_PAGES);
  const recheck = await recheckPages(page, ctx, urlsToRecheck);
  /** true = fired again on a plain visit, false = did not, undefined = page not re-checked */
  const reproduced = (e: (typeof errors)[number]): boolean | undefined => {
    const keys = recheck.get(e.url);
    if (!keys) return undefined;
    return keys.has(errKey(e.message));
  };
  const contextNote = (e: (typeof errors)[number], again: boolean | undefined): string => {
    const during = e.taskTitle ? ` It first appeared while the agent was running "${e.taskTitle}".` : '';
    const disruption = disruptionOf(e.taskFlow);
    if (again === true) return ` It fired again when the agent re-opened the page normally, so it happens on a plain visit.${during}`;
    if (again === false && disruption)
      return ` It did NOT fire again on a normal visit — it appeared only while the agent was ${disruption}, so normal users are unlikely to see it.${during}`;
    if (again === false) return ` It did NOT fire again when the agent re-opened the page normally — it depends on timing or on the steps taken before.${during}`;
    return during;
  };

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
    // A failed load from ANOTHER site (analytics, error-reporting, ads, CDNs of third-party
    // widgets — e.g. SauceDemo's backtrace.io beacon returning 401) is that vendor's problem,
    // not the application's: kept as an info observation with the URL, never a defect.
    let thirdParty = false;
    let spaFallback = false;
    let resourceLabel = '';
    if (isResourceLoadFailure && e.resourceUrl) {
      try {
        const res = new URL(e.resourceUrl);
        const pageHost = new URL(e.url).hostname.split('.').slice(-2).join('.');
        thirdParty = !res.hostname.endsWith(pageHost);
        resourceLabel = `${res.hostname}${res.pathname}`.slice(0, 90);
        // The failed "resource" is the page document itself, yet the page rendered (the agent
        // was on it) — a single-page app served through a 404 fallback. Users are unaffected.
        const pageUrl = new URL(e.url);
        if (!thirdParty && res.pathname === pageUrl.pathname) spaFallback = true;
      } catch {
        /* unparsable — treat as first-party */
      }
    }
    const again = thirdParty || spaFallback ? undefined : reproduced(e);
    const provokedOnly = again === false && !!disruptionOf(e.taskFlow);
    const baseSeverity =
      e.source === 'uncaught exception'
        ? 'high'
        : thirdParty || spaFallback
          ? 'info'
          : isResourceLoadFailure || isCspViolation
            ? 'low'
            : 'medium';
    // Didn't come back on a normal visit: only provoked by the agent's own disruption → a note;
    // otherwise an intermittent error worth a look but not headline severity.
    const severity = provokedOnly ? 'info' : again === false && baseSeverity !== 'info' ? 'low' : baseSeverity;
    ctx.onFinding({
      severity,
      area: 'UI-JsError',
      title: resourceLabel
        ? `${thirdParty ? 'Third-party resource' : 'Resource'} failed to load: ${resourceLabel} (${e.message.match(/status of (\d+)/)?.[1] ?? 'error'})`
        : `JS error: ${e.message.split('\n')[0].trim().slice(0, 140)}`, // full stack stays in "actual"
      steps: [
        ...(ctx.config.credentials && ctx.config.credentials.type !== 'none' ? ['Log in'] : []),
        `Open ${e.url}`,
        'Open browser DevTools → Console (tick "Preserve log")',
        ...(provokedOnly && e.taskTitle ? [`Repeat what the agent was doing at the time: "${e.taskTitle}"`] : []),
      ],
      expected: thirdParty ? 'Third-party resources load without errors (not the application\'s own code)' : 'No uncaught JavaScript errors during normal use',
      actual: `${e.source}: ${e.message}${e.resourceUrl ? ` — failed URL: ${e.resourceUrl}` : ''}${thirdParty ? ' — this URL belongs to a different site, so it is an observation about a third-party service, not a defect in the application' : ''}${spaFallback ? ' — this is the page itself: it is served with an error status but renders normally (single-page-app fallback), so users are unaffected' : ''}.${thirdParty || spaFallback ? '' : contextNote(e, again)}`,
      evidence: e.screenshotPath ? [e.screenshotPath] : [],
      reproRate: again === true ? '2/2 (also on a fresh visit)' : again === false ? '1/2 (not on a fresh visit)' : '1/1',
      automationCandidate: true,
      pageUrl: e.url,
      confidence: again === false ? 'heuristic' : 'verified',
      confidenceReason:
        again === false
          ? 'The browser really emitted this error once, but it did not fire again when the agent re-opened the page normally — it may only happen under the conditions of that moment.'
          : 'Captured directly from the browser\'s own pageerror/console.error events, not inferred.',
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
    const againAny = group.map(reproduced);
    const again: boolean | undefined = againAny.includes(true) ? true : againAny.includes(false) ? false : undefined;
    const provokedOnly = again === false && group.every((g) => !!disruptionOf(g.taskFlow));
    ctx.onFinding({
      severity: provokedOnly ? 'info' : 'low',
      area: 'UI-JsError',
      title: `JS error: SVG chart rendered before its container was sized (${distinctMessages.length} related console error${distinctMessages.length > 1 ? 's' : ''})`,
      steps: [`Open ${url}`, 'Open browser DevTools → Console', 'Watch the console during the chart\'s initial render'],
      expected: 'No uncaught JavaScript errors during normal use',
      actual:
        `${explanation}\n\nRaw console messages observed:\n` +
        distinctMessages.map((m) => `• ${m}`).join('\n') +
        `\n\n${contextNote(group[0], again).trim()}`,
      evidence: screenshot ? [screenshot] : [],
      reproRate:
        again === true
          ? 'Also seen on a fresh visit'
          : 'Intermittent — caught during initial chart render, did not appear when the page was re-opened',
      automationCandidate: true,
      pageUrl: url,
      confidence: again === false ? 'heuristic' : 'verified',
      confidenceReason:
        'Each raw message was captured directly from the browser\'s own console.error events — genuinely thrown, not inferred. Consolidated into one finding because all of them share the same root cause (see Actual) and would otherwise read as several near-identical low-severity findings with the same repro steps.',
    });
  }

  clearTrackedErrors(ctx.sessionId);
}
