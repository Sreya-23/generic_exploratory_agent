// Real device emulation across phones/tablets/browsers — distinct from viewport.ts (which
// only resizes the same Chromium desktop engine) and cross-browser.ts (which compares
// browser engines at a desktop-sized viewport). This uses Playwright's real device
// descriptors: the matching engine (WebKit for iOS devices, Chromium for Android), a real
// mobile user-agent, actual `hasTouch`/`isMobile` flags, and real device pixel ratios —
// catching things a plain viewport resize structurally cannot: hover-only-reachable UI
// that's genuinely inaccessible without a mouse, and server-side content differences a
// real mobile user-agent can trigger that a spoofed-viewport desktop browser never would.
import { chromium, firefox, webkit, devices, type Browser } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import type { Page } from 'playwright';
import { join } from 'node:path';
import { savedSessionStatePath, restoreSessionStorage, waitForRealContent, isLoginWallPage } from './helpers.js';
import { matchesKnownNonBugPattern } from './non-bug-patterns.js';

interface DeviceProfile {
  name: string;
  category: 'phone' | 'tablet';
}

const DEVICE_CATALOG: DeviceProfile[] = [
  { name: 'iPhone 13', category: 'phone' },
  { name: 'iPad (gen 7)', category: 'tablet' },
  { name: 'Pixel 7', category: 'phone' },
  { name: 'Galaxy Tab S4', category: 'tablet' },
  // Smallest common iPhone screen — layouts that survive 390px-wide iPhone 13 often still
  // break at 320px (iPhone SE), a distinct and still-common real-world size.
  { name: 'iPhone SE', category: 'phone' },
  // Landscape orientation — a genuinely different layout mode most sites never get tested
  // in, not just a narrower version of portrait.
  { name: 'iPhone 13 landscape', category: 'phone' },
  { name: 'iPad (gen 7) landscape', category: 'tablet' },
  // Foldable — a distinct aspect ratio/class of device (928x1004, nearly square) that
  // commonly breaks grid/flex layouts tuned only for conventional phone/tablet ratios.
  { name: 'Galaxy Z Fold 6', category: 'tablet' },
];

const ENGINES = { chromium, firefox, webkit } as const;

interface DeviceSignals {
  device: string;
  loaded: boolean;
  title: string;
  bodyTextLength: number;
  interactiveCount: number;
  hoverOnlyCount: number;
  hoverOnlyLabels: string[];
  /** Set when the rendered text matches a known legitimate pattern (app-gate, cookie banner,
   *  maintenance page, etc.) — sparse content here is by design, not a rendering defect. */
  nonBugPattern: string | null;
  screenshotPath?: string;
  /** Set when the page's content/title/interactive counts were measured successfully but the
   *  screenshot itself failed afterward — most commonly the rendering engine crashing while
   *  compositing the page, which is itself real evidence of a cross-engine rendering problem,
   *  not just a missing nicety. */
  screenshotError?: string;
  loadError?: string;
}

async function checkDevice(
  profile: DeviceProfile,
  targetUrl: string,
  ctx: ExecutorContext,
): Promise<DeviceSignals> {
  const descriptor = devices[profile.name];
  const engineName = (descriptor.defaultBrowserType ?? 'chromium') as keyof typeof ENGINES;
  const launcher = ENGINES[engineName];

  let browser: Browser | null = null;
  try {
    browser = await launcher.launch({ headless: true });

    const savedState = savedSessionStatePath(ctx);
    const context = await browser.newContext({
      ...descriptor,
      ignoreHTTPSErrors: true,
      ...(savedState ? { storageState: savedState } : {}),
    });
    if (savedState) {
      await restoreSessionStorage(context, join(ctx.sessionsDir, ctx.sessionId), targetUrl);
    }

    const page: Page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      await browser.close();
      return {
        device: profile.name,
        loaded: false,
        title: '',
        bodyTextLength: 0,
        interactiveCount: 0,
        hoverOnlyCount: 0,
        hoverOnlyLabels: [],
        nonBugPattern: null,
        loadError: (err as Error).message.slice(0, 200),
      };
    }
    await waitForRealContent(page);

    const title = await page.title().catch(() => '');
    const bodyText = await page
      .evaluate(() => (document.body?.innerText ?? '').trim())
      .catch(() => '');
    const bodyTextLength = bodyText.length;
    const nonBugPattern = matchesKnownNonBugPattern(bodyText);
    const interactiveCount = await page
      .locator('button:visible, a[href]:visible, input:visible, select:visible')
      .count()
      .catch(() => 0);

    // Hover-only-reachable elements: something that's only visible/interactive when a real
    // mouse hovers a trigger. On this device hasTouch=true and there IS no hover — this is
    // genuinely, permanently unreachable here, not a false positive from viewport size alone.
    const hoverOnly = await page
      .evaluate(() => {
        const triggers = Array.from(document.querySelectorAll('*'));
        const found: string[] = [];
        for (const el of triggers) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          // A child that's hidden by default but has a sibling/parent rule keyed on :hover
          // can't be detected by static computed-style alone (that only reflects the
          // CURRENT, non-hovered state) — check for elements whose opacity/visibility is
          // near-zero right now but whose parent has a title/aria-haspopup suggesting a
          // hover-revealed submenu, a common real-world pattern (nav dropdowns, tooltips).
          if (
            (style.opacity === '0' || style.visibility === 'hidden') &&
            el.querySelectorAll('a[href], button').length > 0 &&
            (el.className.toString().match(/dropdown|submenu|tooltip|popover|flyout/i))
          ) {
            const label =
              (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) ||
              el.className.toString().slice(0, 40);
            found.push(label);
          }
        }
        return [...new Set(found)].slice(0, 10);
      })
      .catch(() => [] as string[]);

    let screenshotPath: string | undefined;
    let screenshotError: string | undefined;
    try {
      const shotFile = join(
        ctx.sessionsDir,
        ctx.sessionId,
        'screenshots',
        `device-matrix-${profile.name.replace(/[^a-z0-9]+/gi, '-')}.png`,
      );
      await page.screenshot({ path: shotFile, fullPage: false });
      screenshotPath = shotFile;
    } catch (err) {
      // Previously swallowed silently, leaving "Evidence: None attached" with zero
      // explanation of why. Confirmed via live repro: this is commonly WebKit crashing
      // ("Target crashed") while compositing a heavy real-world page, not a transient
      // hiccup — real, useful signal that gets attached to the finding below instead of
      // discarded.
      screenshotError = (err as Error).message.slice(0, 200);
      ctx.onLog(`[DeviceMatrix] ${profile.name}: screenshot failed — ${screenshotError}`);
    }

    await context.close();
    await browser.close();

    return {
      device: profile.name,
      loaded: true,
      title,
      bodyTextLength,
      interactiveCount,
      hoverOnlyCount: hoverOnly.length,
      hoverOnlyLabels: hoverOnly,
      nonBugPattern,
      screenshotPath,
      screenshotError,
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    return {
      device: profile.name,
      loaded: false,
      title: '',
      bodyTextLength: 0,
      interactiveCount: 0,
      hoverOnlyCount: 0,
      hoverOnlyLabels: [],
      nonBugPattern: null,
      loadError: (err as Error).message.slice(0, 200),
    };
  }
}

export async function runDeviceMatrixCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const targetUrl = page.url();
  ctx.onLog(`[DeviceMatrix] Checking ${targetUrl} across real device profiles (phone + tablet, iOS + Android engines)`);

  // smoke/chaos: one quick sample. standard: iOS + Android, phone + tablet (the original
  // 4-device core). deep: the full catalog, including small-screen, landscape, and
  // foldable profiles — each a genuinely distinct layout mode, not just "more of the same."
  const deviceCount = ctx.config.depth === 'smoke' || ctx.config.depth === 'chaos' ? 1
    : ctx.config.depth === 'deep' ? DEVICE_CATALOG.length
    : 4;
  const profiles = DEVICE_CATALOG.slice(0, deviceCount);

  // Reload fresh before measuring the baseline — each device check below does a brand-new
  // page.goto() into a clean context, so comparing against the shared page's current (possibly
  // mid-exploration, mid-modal, or stale) state would be an apples-to-oranges comparison that
  // makes real device differences indistinguishable from "the baseline just hadn't loaded yet."
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await waitForRealContent(page);
  // If auth was expected but the baseline page is still a login/OTP wall, a "content differs"
  // finding below could reflect a real device bug OR just this session's login never having
  // completed — surfaced as an extra confidence caveat rather than skipped, since real bugs
  // (e.g. a device-specific stuck loading state) have genuinely been found this way before.
  const baselineOnLoginWall =
    ctx.config.credentials?.type && ctx.config.credentials.type !== 'none'
      ? await isLoginWallPage(page).catch(() => false)
      : false;
  const baselineTitle = await page.title().catch(() => '');
  const baselineBodyLength = await page
    .evaluate(() => (document.body?.innerText ?? '').trim().length)
    .catch(() => 0);
  const baselineInteractive = await page
    .locator('button:visible, a[href]:visible, input:visible, select:visible')
    .count()
    .catch(() => 0);

  const results = await Promise.all(profiles.map((p) => checkDevice(p, targetUrl, ctx)));

  for (const r of results) {
    if (!r.loaded) {
      ctx.onFinding({
        severity: 'medium',
        area: 'DeviceMatrix',
        title: `Page fails to load on ${r.device}`,
        steps: [`Open ${targetUrl} on a real ${r.device} device profile (or Playwright's device emulation)`],
        expected: 'Page loads successfully on this device',
        actual: r.loadError ?? 'Unknown load failure',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: targetUrl,
      });
      continue;
    }

    const titleDiffers = r.title !== baselineTitle;
    const contentShrunk = baselineBodyLength > 0 && r.bodyTextLength < baselineBodyLength * 0.5;
    const fewerInteractive = baselineInteractive > 0 && r.interactiveCount < baselineInteractive * 0.5;

    if (r.nonBugPattern) {
      // A known legitimate pattern (app-download gate, cookie banner, maintenance page, etc.)
      // — legitimately different/sparse content by design, not a rendering defect. Worth
      // knowing about, not worth reporting as a bug.
      ctx.onLog(
        `[DeviceMatrix] ${r.device} shows a "${r.nonBugPattern}" (${r.title}) instead of the ` +
          'usual page content — matches a known legitimate pattern, not flagged as a defect',
      );
    } else if (titleDiffers || contentShrunk || fewerInteractive) {
      // A screenshot that failed with an actual rendering crash (not just a timeout/network
      // blip) is corroborating evidence, not a gap to apologize for — it means the engine
      // couldn't even finish compositing this page, which independently supports "this
      // device/engine has a real problem with this page" rather than "device-gated by
      // design." Surfaced in both the visible actual text (so it's not silently missing) and
      // the confidence note (so it can upgrade confidence when it's a crash specifically).
      const crashed = !!r.screenshotError?.toLowerCase().includes('crash');
      ctx.onFinding({
        severity: 'medium',
        area: 'DeviceMatrix',
        title: `Rendering/content differs on ${r.device} vs desktop baseline`,
        steps: [`Open ${targetUrl} on ${r.device}`, 'Compare against the desktop Chromium baseline'],
        expected: 'Consistent content and functionality across device profiles',
        actual:
          `title: "${baselineTitle}" → "${r.title}"; ` +
          `content length: ${baselineBodyLength} → ${r.bodyTextLength} chars; ` +
          `interactive elements: ${baselineInteractive} → ${r.interactiveCount}` +
          (r.screenshotError ? `; screenshot could not be captured (${r.screenshotError})` : ''),
        evidence: r.screenshotPath ? [r.screenshotPath] : [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: targetUrl,
        confidence: crashed ? 'verified' : 'heuristic',
        confidenceReason: crashed
          ? `No screenshot could be attached because the rendering engine itself crashed while compositing this page ("${r.screenshotError}") — that's independent, stronger evidence of a real cross-engine rendering problem, not just a content/title mismatch this check might be misreading.`
          : 'A single content/title diff vs. desktop baseline — could reflect a genuine device-specific bug, or a device-gated experience this check doesn\'t recognize yet. Verify visually before treating as confirmed.' +
            (baselineOnLoginWall
              ? ' This session may not have completed login — verify this issue reproduces with a genuinely authenticated session, not just an auth-wall stub.'
              : ''),
      });
    }

    if (r.hoverOnlyCount > 0) {
      ctx.onFinding({
        severity: 'medium',
        area: 'DeviceMatrix',
        title: `${r.hoverOnlyCount} hover-only-reachable element(s) on ${r.device} (no hover on touch)`,
        steps: [
          `Open ${targetUrl} on ${r.device} (hasTouch=true, no mouse hover available)`,
          'Look for menus/tooltips/dropdowns that only appear on :hover',
        ],
        expected: 'Any content reachable via hover should have a touch-accessible equivalent (tap/click trigger)',
        actual: `Hover-dependent element(s) found: ${r.hoverOnlyLabels.join(', ') || '(unlabeled)'}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: targetUrl,
      });
    }

    ctx.onLog(
      `[DeviceMatrix] ${r.device}: title="${r.title}", content=${r.bodyTextLength} chars, ` +
        `interactive=${r.interactiveCount}, hover-only=${r.hoverOnlyCount}`,
    );
  }
}
