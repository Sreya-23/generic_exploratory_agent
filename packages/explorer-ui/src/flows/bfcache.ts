import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Back/forward cache (bfcache) — a page restored via the browser Back button should be
// instantly interactive, not a stale/frozen snapshot. Genuinely observing bfcache under
// CDP automation is limited (devtools attachment can itself suppress bfcache in some
// engine versions), so this is a best-effort signal, not a hard guarantee either way.
export async function runBfcacheCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[BFCache] Checking back/forward-cache restore behaviour');
  const originalUrl = page.url();

  const links = page.locator('a[href]:visible');
  const count = await links.count().catch(() => 0);
  if (count === 0) {
    ctx.onLog('[BFCache] No links to navigate through — skipping');
    return;
  }

  let navigated = false;
  for (let i = 0; i < Math.min(count, 10); i++) {
    const href = await links.nth(i).getAttribute('href').catch(() => null);
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      await links.nth(i).click({ timeout: 2000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
      navigated = true;
      break;
    } catch {
      continue;
    }
  }
  if (!navigated || page.url() === originalUrl) {
    ctx.onLog('[BFCache] Could not navigate to a second page — skipping');
    return;
  }

  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);

  const navType = await page
    .evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav?.type ?? 'unknown';
    })
    .catch(() => 'unknown');
  const isInteractive = await page.evaluate(() => document.readyState === 'complete').catch(() => false);

  if (navType === 'back_forward' && !isInteractive) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-BFCache',
      title: 'Page restored via browser Back is not fully interactive',
      steps: ['Navigate to a second page', 'Click the browser Back button', 'Observe the restored page'],
      expected: 'A back/forward-cache-restored page is immediately interactive, same as a fresh load',
      actual: 'document.readyState was not "complete" immediately after a back_forward navigation restore',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: originalUrl,
    });
  } else {
    ctx.onLog(`[BFCache] Back navigation type=${navType}, interactive=${isInteractive}`);
  }
}
