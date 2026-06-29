import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runNavigation(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  const links = await page.$$eval('a[href]', (els) =>
    els
      .map((a) => {
        const el = a as HTMLAnchorElement;
        return {
          href: el.href,
          rawHref: el.getAttribute('href') ?? '',
          text: el.innerText.trim().slice(0, 50),
        };
      })
      .filter((l) => {
        if (!l.href.startsWith('http') || !l.text.length) return false;
        const raw = l.rawHref.trim().toLowerCase();
        // Skip JS actions and in-page anchors (e.g. Sauce Demo logout href="#")
        if (raw === '#' || raw.startsWith('#')) return false;
        if (raw.startsWith('javascript:')) return false;
        return true;
      })
      .slice(0, 5),
  );

  ctx.onLog(`[Navigation] Testing ${links.length} links`);

  for (const link of links) {
    try {
      const response = await page.goto(link.href, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const status = response?.status() ?? 0;

      if (status >= 400) {
        const shot = join(
          ctx.sessionsDir,
          ctx.sessionId,
          'screenshots',
          `nav-error-${status}.png`,
        );
        await page.screenshot({ path: shot });

        ctx.onFinding({
          severity: status >= 500 ? 'high' : 'medium',
          area: 'UI-Navigation',
          title: `Broken link: "${link.text}" returns ${status}`,
          steps: [
            `From ${ctx.config.targetUrl}`,
            `Click link "${link.text}"`,
            `Observe HTTP ${status}`,
          ],
          expected: 'Page loads with 2xx status',
          actual: `HTTP ${status} for ${link.href}`,
          evidence: [shot],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }
    } catch (err) {
      ctx.onLog(`[Navigation] Failed: ${link.href} — ${(err as Error).message}`);
    }
  }

  await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' });
}
