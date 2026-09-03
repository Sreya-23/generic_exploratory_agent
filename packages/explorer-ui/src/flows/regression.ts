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

export async function runGoldenPath(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[GoldenPath] Capturing golden path snapshots for baseline');

  const goldenDir = join(ctx.sessionsDir, GOLDEN_DIR_NAME);
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
      ctx.onLog(`[GoldenPath] Baseline snapshot established: ${p.name}`);

      ctx.onFinding({
        severity: 'info',
        area: 'Regression-Golden',
        title: `Golden snapshot captured: ${p.name}`,
        steps: [`Navigate to ${p.url}`, 'Take full-page screenshot'],
        expected: 'Baseline established for future visual comparison',
        actual: `Snapshot saved to golden-snapshots/${p.name}.png — future sessions will diff against this`,
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
): Promise<{ diffPct: number; diffPixels: number; totalPixels: number; sizeMismatch: boolean }> {
  const [currentBuf, baselineBuf] = await Promise.all([readFile(currentPath), readFile(baselinePath)]);
  const current = PNG.sync.read(currentBuf);
  const baseline = PNG.sync.read(baselineBuf);

  if (current.width !== baseline.width || current.height !== baseline.height) {
    return {
      diffPct: 100,
      diffPixels: 0,
      totalPixels: 0,
      sizeMismatch: true,
    };
  }

  const { width, height } = current;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(current.data, baseline.data, diff.data, width, height, {
    threshold: 0.1,
  });
  await writeFile(diffOutPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  return { diffPct: (diffPixels / totalPixels) * 100, diffPixels, totalPixels, sizeMismatch: false };
}

export async function runVisualRegression(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[VisualRegression] Comparing current state against golden snapshot (real pixel diff)');

  const goldenDir = join(ctx.sessionsDir, GOLDEN_DIR_NAME);
  const shotDir = join(ctx.sessionsDir, ctx.sessionId, 'screenshots');
  const goldenShot = join(goldenDir, 'home.png');

  if (!existsSync(goldenShot)) {
    ctx.onFinding({
      severity: 'info',
      area: 'Regression-Visual',
      title: 'No golden snapshot found for visual regression comparison',
      steps: ['Check for golden-snapshots directory', 'Load baseline image'],
      expected: 'Golden snapshot available from a previous run',
      actual: 'No baseline found — run the Golden Path Snapshot check first to establish one',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: false,
    });
    return;
  }

  await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const currentShot = join(shotDir, 'visual-regression-home.png');
  await page.screenshot({ path: currentShot, fullPage: true });

  const diffShot = join(shotDir, 'visual-regression-home-diff.png');
  const { diffPct, diffPixels, totalPixels, sizeMismatch } = await diffScreenshots(
    currentShot,
    goldenShot,
    diffShot,
  );

  if (sizeMismatch) {
    ctx.onFinding({
      severity: 'medium',
      area: 'Regression-Visual',
      title: 'Visual regression: page dimensions differ from baseline',
      steps: ['Load homepage', 'Take full-page screenshot', 'Compare dimensions with golden snapshot'],
      expected: 'Screenshot dimensions match baseline (same layout/content length)',
      actual: 'Current screenshot and baseline have different width/height — layout likely changed significantly',
      evidence: [currentShot, goldenShot],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  ctx.onLog(
    `[VisualRegression] ${diffPixels}/${totalPixels} pixels differ (${diffPct.toFixed(2)}%)`,
  );

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
