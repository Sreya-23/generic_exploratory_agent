// H1 — Golden path snapshot / H3 — Visual regression
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const GOLDEN_DIR_NAME = 'golden-snapshots';

export async function runGoldenPath(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[GoldenPath] Capturing golden path snapshots for baseline');

  const goldenDir = join(ctx.sessionsDir, GOLDEN_DIR_NAME);
  await mkdir(goldenDir, { recursive: true });

  const pages = [
    { name: 'home', url: ctx.config.targetUrl },
  ];

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
    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(600);

      const shotPath = join(goldenDir, `${p.name}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      ctx.onLog(`[GoldenPath] Snapshot saved: ${p.name}`);

      ctx.onFinding({
        severity: 'info',
        area: 'Regression-Golden',
        title: `Golden snapshot captured: ${p.name}`,
        steps: [`Navigate to ${p.url}`, 'Take full-page screenshot'],
        expected: 'Baseline established for future visual comparison',
        actual: `Snapshot saved to golden-snapshots/${p.name}.png`,
        evidence: [shotPath],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } catch (err) {
      ctx.onLog(`[GoldenPath] Failed to snapshot ${p.name}: ${(err as Error).message}`);
    }
  }
}

export async function runVisualRegression(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[VisualRegression] Comparing current state against golden snapshots');

  const goldenDir = join(ctx.sessionsDir, GOLDEN_DIR_NAME);
  const shotDir = join(ctx.sessionsDir, ctx.sessionId, 'screenshots');

  let goldenExists = false;
  try {
    await readFile(join(goldenDir, 'home.png'));
    goldenExists = true;
  } catch {
    goldenExists = false;
  }

  if (!goldenExists) {
    ctx.onFinding({
      severity: 'info',
      area: 'Regression-Visual',
      title: 'No golden snapshots found for visual regression comparison',
      steps: ['Check for golden-snapshots directory', 'Load baseline images'],
      expected: 'Golden snapshots available from a previous run',
      actual: 'No baseline found — run "Golden Path Snapshot" test first to establish baseline',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: false,
    });
    return;
  }

  // Take current screenshots and compare (pixel diff approach)
  await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const currentShot = join(shotDir, 'visual-regression-home.png');
  await page.screenshot({ path: currentShot, fullPage: true });

  const goldenShot = join(goldenDir, 'home.png');

  const [currentBuf, goldenBuf] = await Promise.all([
    readFile(currentShot),
    readFile(goldenShot),
  ]);

  if (currentBuf.length !== goldenBuf.length) {
    ctx.onFinding({
      severity: 'medium',
      area: 'Regression-Visual',
      title: 'Visual regression: homepage screenshot size differs from baseline',
      steps: ['Load homepage', 'Take full-page screenshot', 'Compare with golden snapshot'],
      expected: 'Screenshot matches baseline (same dimensions and layout)',
      actual: `Current: ${currentBuf.length} bytes, Baseline: ${goldenBuf.length} bytes — layout likely changed`,
      evidence: [currentShot, goldenShot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    // Quick byte-level diff sample
    let diffBytes = 0;
    const sampleSize = Math.min(currentBuf.length, 10000);
    for (let i = 0; i < sampleSize; i++) {
      if (currentBuf[i] !== goldenBuf[i]) diffBytes++;
    }
    const diffPct = ((diffBytes / sampleSize) * 100).toFixed(1);
    ctx.onLog(`[VisualRegression] Diff: ${diffPct}% of sampled bytes differ`);

    if (diffBytes > sampleSize * 0.05) {
      ctx.onFinding({
        severity: 'low',
        area: 'Regression-Visual',
        title: `Visual regression detected: ~${diffPct}% pixel difference from baseline`,
        steps: ['Load homepage', 'Compare screenshot with golden snapshot'],
        expected: 'Less than 5% pixel difference from baseline',
        actual: `${diffPct}% of sampled bytes differ from golden snapshot`,
        evidence: [currentShot, goldenShot],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog(`[VisualRegression] Visual matches baseline (${diffPct}% diff — within threshold)`);
    }
  }
}
