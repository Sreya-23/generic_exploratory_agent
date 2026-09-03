import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runRtlLayoutCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[RTL] Forcing dir="rtl" to check for hardcoded LTR layout assumptions');
  const originalUrl = page.url();

  try {
    await page.evaluate(() => {
      document.documentElement.setAttribute('dir', 'rtl');
    });
    await page.waitForTimeout(400);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    const { offScreenCount, offScreenLabels } = await page
      .evaluate(() => {
        const isOffScreen = (el: Element) => {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && (rect.right < -50 || rect.left > window.innerWidth + 50);
        };
        const label = (el: Element) => {
          const tag = el.tagName.toLowerCase();
          const cls = el.className?.toString().trim().split(/\s+/)[0];
          const id = (el as HTMLElement).id;
          return id ? `${tag}#${id}` : cls ? `${tag}.${cls}` : tag;
        };
        const all = Array.from(document.querySelectorAll('body *')).slice(0, 2000);
        const labels: string[] = [];
        let n = 0;
        for (const el of all) {
          if (!isOffScreen(el)) continue;
          // Only count this as a distinct defect if its nearest off-screen ancestor is
          // itself NOT already off-screen — otherwise one broken container (e.g. a sidebar
          // pushed off by one hardcoded `left` value) inflates the count by every element
          // nested inside it, which are off-screen as a CONSEQUENCE, not independently.
          let parent = el.parentElement;
          let ancestorAlreadyOffScreen = false;
          while (parent && parent !== document.body) {
            if (isOffScreen(parent)) {
              ancestorAlreadyOffScreen = true;
              break;
            }
            parent = parent.parentElement;
          }
          if (ancestorAlreadyOffScreen) continue;
          n++;
          if (labels.length < 8) labels.push(label(el));
        }
        return { offScreenCount: n, offScreenLabels: labels };
      })
      .catch(() => ({ offScreenCount: 0, offScreenLabels: [] as string[] }));

    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'rtl-layout.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    if (scrollWidth > clientWidth + 20) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-RTL',
        title: 'Layout overflows horizontally when switched to RTL direction',
        steps: [`Open ${originalUrl}`, 'Set document direction to RTL (dir="rtl")', 'Observe horizontal scrolling'],
        expected: 'Layout adapts cleanly to RTL without introducing horizontal scroll',
        actual: `Content is ${scrollWidth}px wide vs a ${clientWidth}px viewport under RTL`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: originalUrl,
      });
    }

    if (offScreenCount > 0) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-RTL',
        title: `${offScreenCount} element(s) pushed off-screen under RTL direction`,
        steps: [`Open ${originalUrl}`, 'Set document direction to RTL (dir="rtl")', 'Inspect element positions'],
        expected: 'Elements using logical (start/end) positioning stay on-screen regardless of text direction',
        actual: `${offScreenCount} root-level element(s) likely use hardcoded left/right positioning and are pushed outside the viewport under RTL: ${offScreenLabels.join(', ')}` +
          (offScreenCount > offScreenLabels.length ? ` (+${offScreenCount - offScreenLabels.length} more)` : ''),
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: false,
        pageUrl: originalUrl,
      });
    }

    if (scrollWidth <= clientWidth + 20 && offScreenCount === 0) {
      ctx.onLog('[RTL] Layout held up cleanly under forced RTL direction');
    }
  } finally {
    await page
      .evaluate(() => {
        document.documentElement.removeAttribute('dir');
      })
      .catch(() => {});
  }
}
