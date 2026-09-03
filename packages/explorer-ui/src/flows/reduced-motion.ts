import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent } from './helpers.js';

export async function runReducedMotionCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[ReducedMotion] Checking whether animations respect prefers-reduced-motion');
  const originalUrl = page.url();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await waitForRealContent(page);
  await page.waitForTimeout(500);

  const runningAnimations = await page
    .evaluate(() => {
      if (typeof document.getAnimations !== 'function') return [];
      return document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => {
          const effect = a.effect as KeyframeEffect | null;
          const target = effect?.target as Element | null;
          if (!target) return 'unknown';
          const cls = target.className?.toString().split(' ')[0];
          return target.tagName.toLowerCase() + (cls ? `.${cls}` : '');
        });
    })
    .catch(() => [] as string[]);

  await page.emulateMedia({ reducedMotion: null }).catch(() => {});

  const unique = [...new Set(runningAnimations)].slice(0, 8);
  if (unique.length === 0) {
    ctx.onLog('[ReducedMotion] No animations ignoring prefers-reduced-motion');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'reduced-motion.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'low',
    area: 'UI-Motion',
    title: `${unique.length} animation(s) continue running despite prefers-reduced-motion`,
    steps: [
      `Open ${originalUrl}`,
      'Set the OS/browser preference to reduce motion',
      'Reload the page and check for elements still animating',
    ],
    expected: 'Animations pause or reduce when the OS-level reduced-motion preference is set',
    actual: `Still animating: ${unique.join(', ')}`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: originalUrl,
  });
}
