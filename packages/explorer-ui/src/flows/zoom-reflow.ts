import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// WCAG 1.4.10 Reflow — content zoomed to 400% must not require two-dimensional scrolling.
// Genuine browser zoom changes how em/rem/vw-based layouts reflow differently than a plain
// viewport resize (viewport.ts's fixed breakpoints) does — this is the distinct thing a
// resize-only check can't catch.
const ZOOM_LEVELS = [
  { label: '200%', factor: 2 },
  { label: '400%', factor: 4 },
];

export async function runZoomReflow(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[ZoomReflow] Checking layout reflow at 200%/400% browser zoom (WCAG 1.4.10)');
  const originalUrl = page.url();

  for (const zoom of ZOOM_LEVELS) {
    try {
      await page.evaluate((factor) => {
        (document.documentElement.style as unknown as { zoom: string }).zoom = String(factor);
      }, zoom.factor);
      await page.waitForTimeout(300);

      // document.documentElement.scrollWidth/clientWidth are NOT reliable under the
      // non-standard CSS `zoom` property: clientWidth never adjusts to reflect the
      // "effective" shrunk viewport while scrollWidth balloons with the zoom factor
      // regardless of whether the actual content overflows — confirmed on a page with no
      // real overflow at any zoom level (documentElement.scrollWidth reported 1280→1536→3072
      // across 1x/2x/4x zoom while clientWidth stayed pinned at 1280, producing a false
      // "overflow" at every zoom level on every site tested). document.body.scrollWidth
      // compared against window.innerWidth (both stable, unaffected by this quirk) reflects
      // the real content width instead.
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.body?.scrollWidth ?? document.documentElement.scrollWidth,
        clientWidth: window.innerWidth,
      }));

      if (scrollWidth > clientWidth + 5) {
        const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `zoom-reflow-${zoom.factor}x.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Zoom',
          title: `Content requires horizontal scrolling at ${zoom.label} browser zoom`,
          steps: [
            `Open ${originalUrl}`,
            `Zoom the browser to ${zoom.label}`,
            'Observe the page now needs horizontal scrolling to read all content',
          ],
          expected: 'Per WCAG 1.4.10, content reflows to fit without 2D scrolling at up to 400% zoom',
          actual: `Content is ${scrollWidth}px wide but the viewport is only ${clientWidth}px at ${zoom.label} zoom`,
          evidence: [shot],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: originalUrl,
        });
      }
    } catch (err) {
      ctx.onLog(`[ZoomReflow] Failed to test ${zoom.label} zoom: ${(err as Error).message.slice(0, 100)}`);
    } finally {
      await page
        .evaluate(() => {
          (document.documentElement.style as unknown as { zoom: string }).zoom = '1';
        })
        .catch(() => {});
    }
  }
}
