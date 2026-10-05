// Cross-browser compatibility spot-check — everything else in this agent runs Chromium
// only. This flow opens the same landing page in Firefox and WebKit too, and flags
// meaningful divergence (console errors, missing content, broken layout) that a
// Chromium-only run structurally cannot see.
import { chromium, firefox, webkit, type Browser } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import type { Page } from 'playwright';
import { join } from 'node:path';
import { savedSessionStatePath, restoreSessionStorage, waitForRealContent, waitForTitleStable } from './helpers.js';

// Ground truth for the report's environment-comparison grid: findings alone only ever record
// failures, so without this, a page that PASSED in an environment would render as a blank cell
// rather than a ✓ — indistinguishable from "never checked."
function recordCheck(
  ctx: ExecutorContext,
  pageUrl: string,
  environment: string,
  ok: boolean,
  note?: string,
): void {
  ctx.environmentChecks = [
    ...(ctx.environmentChecks ?? []),
    { pageUrl, environment, kind: 'browser', ok, note },
  ];
}

interface EngineSignals {
  engine: string;
  loaded: boolean;
  title: string;
  bodyTextLength: number;
  visibleInteractiveCount: number;
  consoleErrors: string[];
  loadError?: string;
  screenshotPath?: string;
}

async function collectSignals(page: Page, engine: string): Promise<EngineSignals> {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 150));
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message.slice(0, 150)));

  const title = await page.title().catch(() => '');
  const bodyTextLength = await page
    .evaluate(() => (document.body?.innerText ?? '').trim().length)
    .catch(() => 0);
  const visibleInteractiveCount = await page
    .locator('button:visible, a[href]:visible, input:visible, select:visible')
    .count()
    .catch(() => 0);

  return { engine, loaded: true, title, bodyTextLength, visibleInteractiveCount, consoleErrors: [...new Set(consoleErrors)] };
}

async function checkEngine(
  launcher: { launch: (opts?: { headless?: boolean }) => Promise<Browser> },
  engineName: string,
  targetUrl: string,
  ctx: ExecutorContext,
): Promise<EngineSignals> {
  let browser: Browser | null = null;
  try {
    browser = await launcher.launch({ headless: true });
    // Without this, Firefox/WebKit navigate cold with zero authentication while the
    // Chromium baseline reuses the already-logged-in session — on any site that requires
    // auth, that alone produces a "differs" finding (stuck on the login page) that has
    // nothing to do with actual cross-browser rendering/behavior differences.
    const savedState = savedSessionStatePath(ctx);
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(savedState ? { storageState: savedState } : {}),
    });
    if (savedState) {
      await restoreSessionStorage(context, join(ctx.sessionsDir, ctx.sessionId), targetUrl);
    }
    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      return {
        engine: engineName,
        loaded: false,
        title: '',
        bodyTextLength: 0,
        visibleInteractiveCount: 0,
        consoleErrors: [],
        loadError: (err as Error).message.slice(0, 200),
      };
    }
    await waitForTitleStable(page);
    await waitForRealContent(page);
    const signals = await collectSignals(page, engineName);
    const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `cross-browser-${engineName}.png`);
    // Only claim the screenshot as evidence if it actually got written — silently swallowing
    // the failure here previously left findings pointing at paths that were never created.
    try {
      await page.screenshot({ path: shotPath, fullPage: false });
      signals.screenshotPath = shotPath;
    } catch {
      /* no screenshot this run — the finding will just carry no evidence instead of a broken path */
    }
    return signals;
  } catch (err) {
    return {
      engine: engineName,
      loaded: false,
      title: '',
      bodyTextLength: 0,
      visibleInteractiveCount: 0,
      consoleErrors: [],
      loadError: (err as Error).message.slice(0, 200),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Checks ONE url across Firefox/WebKit against a Chromium baseline and emits findings.
 * `liveChromiumPage`, when given, is reused for the baseline (saves a browser launch for
 * whichever page the task is already sitting on) — otherwise a fresh Chromium instance is
 * launched for the baseline too, exactly like checkEngine() already does for the other two
 * engines, so every additional page gets the same three-way comparison, not a degraded one.
 */
async function checkPageAcrossEngines(
  targetUrl: string,
  ctx: ExecutorContext,
  liveChromiumPage: Page | null,
): Promise<void> {
  ctx.onLog(`[CrossBrowser] Checking ${targetUrl} in Firefox and WebKit against the Chromium baseline`);

  let chromiumSignals: EngineSignals;
  if (liveChromiumPage) {
    // Same stability wait as checkEngine() uses for Firefox/WebKit below, so all three
    // engines are captured on equal footing regardless of which one settles slower.
    await waitForTitleStable(liveChromiumPage);
    await waitForRealContent(liveChromiumPage);
    chromiumSignals = await collectSignals(liveChromiumPage, 'chromium');
  } else {
    chromiumSignals = await checkEngine(chromium, 'chromium', targetUrl, ctx);
    if (chromiumSignals.loadError) {
      recordCheck(ctx, targetUrl, 'Chromium', false, chromiumSignals.loadError);
      ctx.onLog(`[CrossBrowser] Chromium itself failed to load ${targetUrl} — skipping this page's comparison entirely (nothing to baseline against)`);
      return;
    }
  }
  recordCheck(ctx, targetUrl, 'Chromium', true);

  const [firefoxSignals, webkitSignals] = await Promise.all([
    checkEngine(firefox, 'firefox', targetUrl, ctx),
    checkEngine(webkit, 'webkit', targetUrl, ctx),
  ]);

  for (const other of [firefoxSignals, webkitSignals]) {
    const engineLabel = other.engine.charAt(0).toUpperCase() + other.engine.slice(1);
    if (other.loadError) {
      recordCheck(ctx, targetUrl, engineLabel, false, other.loadError);
      ctx.onFinding({
        severity: 'high',
        area: 'CrossBrowser',
        title: `Page fails to load in ${other.engine}`,
        steps: [`Open ${targetUrl} in ${other.engine}`],
        expected: 'Page loads successfully across all major browser engines',
        actual: `${other.engine} failed to load the page: ${other.loadError}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      continue;
    }

    const issues: string[] = [];
    if (other.title !== chromiumSignals.title) {
      issues.push(`title differs (chromium: "${chromiumSignals.title}", ${other.engine}: "${other.title}")`);
    }
    // A large drop in body text or interactive element count suggests content/layout that
    // didn't render — a real cross-browser rendering bug, not just minor text reflow.
    const textDropPct =
      chromiumSignals.bodyTextLength > 0
        ? ((chromiumSignals.bodyTextLength - other.bodyTextLength) / chromiumSignals.bodyTextLength) * 100
        : 0;
    if (textDropPct > 30) {
      issues.push(
        `visible text is ${textDropPct.toFixed(0)}% shorter than in Chromium (${other.bodyTextLength} vs ${chromiumSignals.bodyTextLength} chars) — content may not have rendered`,
      );
    }
    const interactiveDropPct =
      chromiumSignals.visibleInteractiveCount > 0
        ? ((chromiumSignals.visibleInteractiveCount - other.visibleInteractiveCount) /
            chromiumSignals.visibleInteractiveCount) *
          100
        : 0;
    if (interactiveDropPct > 30) {
      issues.push(
        `${other.visibleInteractiveCount} visible interactive elements vs ${chromiumSignals.visibleInteractiveCount} in Chromium — some controls may be missing or hidden`,
      );
    }
    if (other.consoleErrors.length > 0) {
      issues.push(`${other.consoleErrors.length} console error(s) not seen in Chromium: ${other.consoleErrors.slice(0, 3).join('; ')}`);
    }

    if (issues.length > 0) {
      recordCheck(ctx, targetUrl, engineLabel, false, issues.join('; '));
      ctx.onFinding({
        severity: 'medium',
        area: 'CrossBrowser',
        title: `Rendering/behavior differs in ${other.engine} vs Chromium`,
        steps: [`Open ${targetUrl} in ${other.engine}`, 'Compare against the same page in Chromium'],
        expected: 'Consistent content and behavior across browser engines',
        actual: issues.join('; '),
        evidence: other.screenshotPath ? [other.screenshotPath] : [],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      recordCheck(ctx, targetUrl, engineLabel, true);
      ctx.onLog(`[CrossBrowser] ${other.engine} matches Chromium baseline — no divergence detected`);
    }
  }
}

// Pages whose URL suggests real interactive/transactional content are where a cross-engine
// rendering difference is actually likely to matter (a form that silently fails to render in
// WebKit is a real problem; a static content page rendering identically everywhere is much
// less likely to diverge in the first place) — preferred over an arbitrary alternate page.
const HIGH_VALUE_PATH_HINT = /checkout|payment|pay|form|create|edit|settings|cart|invoice|collect/i;

function pickAdditionalPage(currentUrl: string, discoveredRoutes: string[] | undefined): string | null {
  if (!discoveredRoutes || discoveredRoutes.length === 0) return null;
  const candidates = discoveredRoutes.filter((u) => u !== currentUrl);
  if (candidates.length === 0) return null;
  return candidates.find((u) => HIGH_VALUE_PATH_HINT.test(u)) ?? candidates[0];
}

/**
 * `page` here is the existing Chromium page (used as the baseline for whichever page the
 * task is already on); this flow additionally launches Firefox and WebKit against that same
 * URL and compares — and, at standard/deep depth, does the same three-way comparison again
 * for one more discovered page, since a single landing-page spot-check structurally cannot
 * catch a rendering divergence that only shows up on a form/checkout/settings page it never
 * visits. Bounded to exactly one extra page — each one costs 3 more browser launches.
 */
export async function runCrossBrowserCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const currentUrl = page.url();
  await checkPageAcrossEngines(currentUrl, ctx, page);

  if (ctx.config.depth === 'standard' || ctx.config.depth === 'deep') {
    const extraUrl = pickAdditionalPage(currentUrl, ctx.discoveredRoutes);
    if (extraUrl) {
      ctx.onLog(`[CrossBrowser] Also checking a second discovered page: ${extraUrl}`);
      await checkPageAcrossEngines(extraUrl, ctx, null);
    } else {
      ctx.onLog('[CrossBrowser] No additional discovered page available to check beyond the current one');
    }
  }
}
