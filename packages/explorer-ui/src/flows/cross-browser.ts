// Cross-browser compatibility spot-check — everything else in this agent runs Chromium
// only. This flow opens the same landing page in Firefox and WebKit too, and flags
// meaningful divergence (console errors, missing content, broken layout) that a
// Chromium-only run structurally cannot see.
import { firefox, webkit, type Browser } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import type { Page } from 'playwright';
import { join } from 'node:path';
import { savedSessionStatePath, restoreSessionStorage, waitForRealContent } from './helpers.js';

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

/**
 * Wait until document.title stops changing, rather than a fixed delay. Different browser
 * engines take genuinely different, variable amounts of time to run the same client-side JS
 * (an SPA setting its title post-load, for instance) — a fixed wait that happens to be enough
 * for one engine is routinely not enough for another, producing a false "differs" finding
 * that's really just a race, not a real difference.
 *
 * Requires the title to be unchanged across TWO consecutive checks, not one, after an initial
 * grace period. Checking only once is indistinguishable between "already settled" and "hasn't
 * started changing yet" — sampled a beat before the update begins, both look identical, and a
 * single-check version returns "stable" while genuinely still mid-change.
 */
async function waitForTitleStable(page: Page, timeoutMs = 5000): Promise<void> {
  await page.waitForTimeout(1000); // let a title-changing script have a real chance to start
  const deadline = Date.now() + timeoutMs;
  let last = await page.title().catch(() => '');
  let stableRounds = 0;
  while (Date.now() < deadline && stableRounds < 2) {
    await page.waitForTimeout(300);
    const current = await page.title().catch(() => '');
    if (current === last) {
      stableRounds++;
    } else {
      stableRounds = 0;
      last = current;
    }
  }
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
 * `page` here is the existing Chromium page (used as the baseline); this flow additionally
 * launches Firefox and WebKit against the same URL and compares.
 */
export async function runCrossBrowserCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const targetUrl = page.url();
  ctx.onLog(`[CrossBrowser] Checking ${targetUrl} in Firefox and WebKit against the Chromium baseline`);

  // Same stability wait as checkEngine() uses for Firefox/WebKit below, so all three engines
  // are captured on equal footing regardless of which one happens to settle slower this run.
  await waitForTitleStable(page);
  await waitForRealContent(page);
  const chromiumSignals = await collectSignals(page, 'chromium');

  const [firefoxSignals, webkitSignals] = await Promise.all([
    checkEngine(firefox, 'firefox', targetUrl, ctx),
    checkEngine(webkit, 'webkit', targetUrl, ctx),
  ]);

  for (const other of [firefoxSignals, webkitSignals]) {
    if (other.loadError) {
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
      ctx.onLog(`[CrossBrowser] ${other.engine} matches Chromium baseline — no divergence detected`);
    }
  }
}
