// Crawls same-origin links found on the current page and flags any returning 4xx/5xx.
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const MAX_LINKS_TO_CHECK = 20;

export async function runDeadLinksCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[UI] Checking same-origin links for dead (4xx/5xx) responses');

  const pageUrl = page.url();
  const origin = new URL(pageUrl).origin;
  const links = await page.evaluate((org) => {
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const seen = new Set<string>();
    const result: Array<{ href: string; text: string }> = [];
    for (const a of anchors) {
      try {
        const u = new URL(a.href);
        if (u.origin === org && !u.hash && u.href !== location.href && !seen.has(u.href)) {
          seen.add(u.href);
          result.push({ href: u.href, text: (a.textContent ?? '').trim().slice(0, 40) || '(no visible text)' });
        }
      } catch {
        /* ignore invalid href */
      }
    }
    return result;
  }, origin);

  const toCheck = links.slice(0, MAX_LINKS_TO_CHECK);
  const dead: string[] = [];

  for (const link of toCheck) {
    try {
      const res = await page.context().request.get(link.href, { timeout: 8000, failOnStatusCode: false });
      if (res.status() >= 400) {
        dead.push(`"${link.text}" → ${link.href} → HTTP ${res.status()}`);
      }
    } catch {
      dead.push(`"${link.text}" → ${link.href} → request failed`);
    }
  }

  if (dead.length === 0) {
    ctx.onLog(`[UI] Checked ${toCheck.length} internal link(s) — no dead links found`);
    return;
  }

  ctx.onFinding({
    severity: 'medium',
    area: 'UI-DeadLinks',
    title: `${dead.length} internal link(s) return an error status`,
    steps: [
      `Open ${pageUrl}`,
      'Find each link listed below by its visible text, and click it (or paste its URL directly into the address bar)',
      'Observe the resulting HTTP error instead of a working page',
    ],
    expected: 'All internal links return a successful (2xx/3xx) response',
    actual: dead.join('; '),
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
  });
}
