// H1 — Golden path snapshot / H3 — Visual regression
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const GOLDEN_DIR_NAME = 'golden-snapshots';
// Below this, treat differences as noise (font antialiasing, clock/date widgets, etc.)
// rather than a real visual regression.
const DIFF_PCT_THRESHOLD = 1.5;

// Baselines MUST be scoped to the site and to who is logged in. They used to live in one shared
// `golden-snapshots/home.png` for every target, so a session against site B was pixel-diffed
// against a screenshot of site A taken weeks earlier (observed: a 50.94% "regression" on
// SauceDemo that was really a comparison with a different website). Different accounts on the
// same site also legitimately render different pages, so the login identity is part of the key.
function baselineDir(ctx: ExecutorContext): string {
  let host = 'unknown-host';
  try {
    host = new URL(ctx.config.targetUrl).hostname;
  } catch {
    /* keep fallback */
  }
  const cred = ctx.config.credentials;
  const who =
    !cred || cred.type === 'none'
      ? 'anonymous'
      : cred.type === 'login'
        ? `login-${(cred.username ?? 'user').replace(/[^\w.-]+/g, '_')}`
        : cred.type;
  return join(ctx.sessionsDir, GOLDEN_DIR_NAME, host.replace(/[^\w.-]+/g, '_'), who);
}

interface BaselineMeta {
  url: string;
  landedUrl: string;
  width: number;
  capturedAt: string;
}

function pathOnly(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u;
  }
}

export async function runGoldenPath(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[GoldenPath] Capturing golden path snapshots for baseline');

  const goldenDir = baselineDir(ctx);
  await mkdir(goldenDir, { recursive: true });

  const pages = [{ name: 'home', url: ctx.config.targetUrl }];

  // Discover a few key pages to snapshot
  const links = await page.$$eval('nav a, [role="navigation"] a', (els) =>
    els.slice(0, 5).map((el) => ({ href: (el as HTMLAnchorElement).href, text: el.textContent?.trim() ?? '' })),
  );

  for (const link of links) {
    if (link.href && link.href.startsWith('http') && !link.href.includes('#')) {
      pages.push({ name: link.text.toLowerCase().replace(/\s+/g, '-').slice(0, 30), url: link.href });
    }
  }

  for (const p of pages.slice(0, 5)) {
    const shotPath = join(goldenDir, `${p.name}.png`);

    // Only establish a baseline once — a session that runs golden-path every time and
    // overwrites the previous baseline with THIS run's own screenshot makes visual
    // regression meaningless (the "baseline" would always match the current run, since it
    // was captured moments earlier in the same session). Re-baselining should be a deliberate
    // choice (delete the file), not an automatic side effect of running a session.
    if (existsSync(shotPath)) {
      ctx.onLog(`[GoldenPath] Baseline already exists for "${p.name}" — leaving it in place`);
      continue;
    }

    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(600);

      await page.screenshot({ path: shotPath, fullPage: true });
      const meta: BaselineMeta = {
        url: p.url,
        landedUrl: page.url(),
        width: page.viewportSize()?.width ?? 0,
        capturedAt: new Date().toISOString(),
      };
      await writeFile(shotPath.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
      ctx.onLog(`[GoldenPath] Baseline snapshot established: ${p.name} (${goldenDir})`);

      ctx.onFinding({
        severity: 'info',
        area: 'Regression-Golden',
        title: `Golden snapshot captured: ${p.name}`,
        steps: [`Navigate to ${p.url}`, 'Take full-page screenshot'],
        expected: 'Baseline established for future visual comparison',
        actual: `Snapshot saved to ${join(goldenDir, `${p.name}.png`)} — future sessions against this site and login will diff against this`,
        evidence: [shotPath],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } catch (err) {
      ctx.onLog(`[GoldenPath] Failed to snapshot ${p.name}: ${(err as Error).message}`);
    }
  }
}

/** Decode two same-size-or-not PNGs and compute a real pixel-level diff via pixelmatch. */
async function diffScreenshots(
  currentPath: string,
  baselinePath: string,
  diffOutPath: string,
): Promise<{ diffPct: number; diffPixels: number; totalPixels: number; sizeMismatch: boolean; heightChangePct: number }> {
  const [currentBuf, baselineBuf] = await Promise.all([readFile(currentPath), readFile(baselinePath)]);
  const current = PNG.sync.read(currentBuf);
  const baseline = PNG.sync.read(baselineBuf);

  if (current.width !== baseline.width) {
    return { diffPct: 100, diffPixels: 0, totalPixels: 0, sizeMismatch: true, heightChangePct: 0 };
  }

  // Full-page screenshots change height whenever list content grows or shrinks by a row. That is
  // a content change, not a visual regression — compare the overlapping top region pixel by
  // pixel and report the height change separately.
  const width = current.width;
  const height = Math.min(current.height, baseline.height);
  const crop = (img: PNG) => {
    if (img.height === height) return img.data;
    return img.data.subarray(0, width * height * 4);
  };
  const heightChangePct = (Math.abs(current.height - baseline.height) / baseline.height) * 100;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(crop(current), crop(baseline), diff.data, width, height, {
    threshold: 0.1,
  });
  await writeFile(diffOutPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  return { diffPct: (diffPixels / totalPixels) * 100, diffPixels, totalPixels, sizeMismatch: false, heightChangePct };
}

export async function runVisualRegression(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[VisualRegression] Comparing current state against golden snapshot (real pixel diff)');

  const goldenDir = baselineDir(ctx);
  const shotDir = join(ctx.sessionsDir, ctx.sessionId, 'screenshots');
  const goldenShot = join(goldenDir, 'home.png');
  const metaPath = join(goldenDir, 'home.json');

  if (!existsSync(goldenShot)) {
    ctx.onFinding({
      severity: 'info',
      area: 'Regression-Visual',
      title: 'No golden snapshot found for visual regression comparison',
      steps: ['Check for golden-snapshots directory', 'Load baseline image'],
      expected: 'Golden snapshot available from a previous run',
      actual: `No baseline found for this site and login yet (${goldenDir}) — this run's Golden Path Snapshot creates one; later runs compare against it`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: false,
    });
    return;
  }

  await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  // Only compare like with like: if this run landed somewhere else than the baseline did (e.g.
  // the baseline caught the login form and this run is already signed in, or vice versa), a
  // pixel diff measures the redirect, not a regression.
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as BaselineMeta;
      if (pathOnly(meta.landedUrl) !== pathOnly(page.url())) {
        ctx.onLog(
          `[VisualRegression] Baseline was taken on ${meta.landedUrl}, this run landed on ${page.url()} — different page, skipping comparison`,
        );
        return;
      }
    } catch {
      /* unreadable meta — fall through and compare */
    }
  }

  const currentShot = join(shotDir, 'visual-regression-home.png');
  await page.screenshot({ path: currentShot, fullPage: true });

  const diffShot = join(shotDir, 'visual-regression-home-diff.png');
  const { diffPct, diffPixels, totalPixels, sizeMismatch, heightChangePct } = await diffScreenshots(
    currentShot,
    goldenShot,
    diffShot,
  );

  if (sizeMismatch) {
    ctx.onFinding({
      severity: 'medium',
      area: 'Regression-Visual',
      title: 'Visual regression: page width differs from baseline',
      steps: ['Load homepage', 'Take full-page screenshot', 'Compare dimensions with golden snapshot'],
      expected: 'Screenshot width matches baseline',
      actual: 'Current screenshot and baseline have different widths — horizontal overflow or a layout change',
      evidence: [currentShot, goldenShot],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  ctx.onLog(
    `[VisualRegression] ${diffPixels}/${totalPixels} pixels differ (${diffPct.toFixed(2)}%)` +
      (heightChangePct > 0 ? `; page height changed ${heightChangePct.toFixed(1)}%` : ''),
  );
  if (heightChangePct > 25) {
    ctx.onFinding({
      severity: 'low',
      area: 'Regression-Visual',
      title: `Page length changed ${heightChangePct.toFixed(0)}% since the baseline`,
      steps: ['Load homepage', 'Take a full-page screenshot', 'Compare its height with the stored baseline'],
      expected: 'Page length roughly the same as the baseline',
      actual: `Height changed by ${heightChangePct.toFixed(1)}% — content was added or removed; check it was intentional`,
      evidence: [currentShot, goldenShot],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'A height change is often legitimate new content, so this is a prompt to look, not a confirmed defect.',
    });
  }

  if (diffPct > DIFF_PCT_THRESHOLD) {
    ctx.onFinding({
      severity: diffPct > 10 ? 'high' : diffPct > 5 ? 'medium' : 'low',
      area: 'Regression-Visual',
      title: `Visual regression detected: ${diffPct.toFixed(2)}% pixel difference from baseline`,
      steps: [
        'Load homepage',
        'Take a full-page screenshot',
        'Compare pixel-by-pixel against the stored golden snapshot',
        'Open the diff image (evidence) — differing pixels are highlighted',
      ],
      expected: `Less than ${DIFF_PCT_THRESHOLD}% pixel difference from baseline`,
      actual: `${diffPct.toFixed(2)}% of pixels (${diffPixels}/${totalPixels}) differ from the golden snapshot`,
      evidence: [currentShot, goldenShot, diffShot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog(`[VisualRegression] Visual matches baseline (${diffPct.toFixed(2)}% diff — within threshold)`);
  }
}
