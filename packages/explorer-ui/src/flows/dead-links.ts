// Crawls same-origin links found on the current page and flags any returning 4xx/5xx.
// Also checks where links to OTHER sites point (see checkOutboundLinks) — read-only, one
// request per link, never clicking or filling anything on the other site.
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const MAX_LINKS_TO_CHECK = 20;
const MAX_OUTBOUND_TO_CHECK = 15;

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
  const softErrors: string[] = [];

  for (const link of toCheck) {
    let status: number | null = null;
    try {
      const res = await page.context().request.get(link.href, { timeout: 8000, failOnStatusCode: false });
      status = res.status();
    } catch {
      status = null;
    }
    if (status !== null && status < 400) continue;

    // A raw HTTP status is not what the user sees. Single-page apps hosted on static storage
    // (SauceDemo: /inventory.html → HTTP 404) return an error status for deep links and then
    // render the real page anyway via their 404 fallback. Only call a link dead when the page
    // ALSO fails to render in a real browser.
    const rendered = await rendersRealPage(page, link.href);
    const label = `"${link.text}" → ${link.href} → ${status === null ? 'request failed' : `HTTP ${status}`}`;
    if (rendered) softErrors.push(label);
    else dead.push(label);
  }

  if (softErrors.length > 0) {
    ctx.onFinding({
      severity: 'info',
      area: 'UI-DeadLinks',
      title: `${softErrors.length} internal link(s) work in the browser but return an error status code`,
      steps: [`Open ${pageUrl}`, 'Request each URL below directly (curl / DevTools → Network) and note the status', 'Open the same URL in the browser — the page still renders'],
      expected: 'Pages that render normally are served with HTTP 200',
      actual: `${softErrors.join('; ')} — but the page renders normally (single-page-app fallback). Users are unaffected; uptime monitors, crawlers and link checkers will see an error`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: false,
      confidence: 'verified',
      confidenceReason: 'Raw status from a direct request, plus a real browser load showing the page renders.',
    });
  }

  await checkOutboundLinks(page, ctx);

  if (dead.length === 0) {
    ctx.onLog(`[UI] Checked ${toCheck.length} internal link(s) — no dead links found`);
    return;
  }

  ctx.onFinding({
    severity: 'medium',
    area: 'UI-DeadLinks',
    title: `${dead.length} internal link(s) are broken`,
    steps: [
      `Open ${pageUrl}`,
      'Find each link listed below by its visible text, and click it (or paste its URL directly into the address bar)',
      'Observe the error page instead of a working page',
    ],
    expected: 'All internal links open a working page',
    actual: dead.join('; '),
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
    confidence: 'verified',
    confidenceReason: 'Error status from a direct request AND no real content when opened in the browser.',
  });
}

const NOT_FOUND_TEXT = /\b(404|not found|page (does not|doesn't) exist|no longer available|error occurred|server error)\b/i;

/** Opens the URL in a throwaway tab of the same (authenticated) context and checks it shows real content. */
async function rendersRealPage(page: Page, url: string): Promise<boolean> {
  const probe = await page.context().newPage().catch(() => null);
  if (!probe) return false;
  try {
    await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await probe.waitForTimeout(1200);
    const info = await probe.evaluate(() => ({
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      interactive: document.querySelectorAll('a[href], button, input, select').length,
      title: document.title,
    }));
    const head = `${info.title} ${info.text.slice(0, 300)}`;
    if (NOT_FOUND_TEXT.test(head)) return false;
    return info.text.length > 150 && info.interactive >= 3;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

// A URL whose path is itself an error page: /404, /error/404, /not-found, /page-not-found …
const ERROR_PAGE_PATH = /(^|\/)(error\/)?(404|410|not-?found|page-?not-?found)(\/|\.html?|$)/i;
// Statuses that mean "really not there". Others are deliberately ignored for other sites:
// 401/403/429/999 are what big sites (LinkedIn, X, Facebook…) send to automated visitors even
// when the page works, and 5xx on someone else's server is usually transient.
const GONE_STATUSES = new Set([404, 410]);

/**
 * The site's own links to other sites (About, docs, blog, social…), including ones inside
 * hidden menus. Testing other sites is out of scope, but WHERE our links point is our bug:
 * a link written as https://vendor.com/error/404 is broken no matter how that site behaves.
 * Read-only: one GET per link through the browser's request API — no page is opened or clicked.
 */
async function checkOutboundLinks(page: Page, ctx: ExecutorContext): Promise<void> {
  const pageUrl = page.url();
  const links = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const out: Array<{ href: string; text: string; hidden: boolean }> = [];
      for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
        try {
          const u = new URL(a.href);
          if (!/^https?:$/.test(u.protocol) || u.hostname === location.hostname) continue;
          u.hash = '';
          if (seen.has(u.href)) continue;
          seen.add(u.href);
          const r = a.getBoundingClientRect();
          const text = (a.textContent ?? '').trim() || a.getAttribute('aria-label') || a.title || '';
          out.push({ href: u.href, text: text.slice(0, 40) || '(no visible text)', hidden: r.width === 0 || r.height === 0 });
        } catch {
          /* ignore invalid href */
        }
      }
      return out;
    })
    .catch(() => [] as Array<{ href: string; text: string; hidden: boolean }>);

  const toCheck = links.slice(0, MAX_OUTBOUND_TO_CHECK);
  if (toCheck.length === 0) return;
  ctx.onLog(`[UI] Checking where ${toCheck.length} link(s) to other sites point (one request each, nothing clicked there)`);

  const broken: Array<{ label: string; verified: boolean }> = [];
  for (const link of toCheck) {
    let status: number | null = null;
    let finalUrl = link.href;
    try {
      const res = await page.context().request.get(link.href, { timeout: 8000, failOnStatusCode: false, maxRedirects: 5 });
      status = res.status();
      finalUrl = res.url();
    } catch {
      status = null; // unreachable from here — not evidence of anything
    }
    const pathOf = (u: string) => {
      try {
        return new URL(u).pathname;
      } catch {
        return '';
      }
    };
    const hrefIsErrorPage = ERROR_PAGE_PATH.test(pathOf(link.href));
    const landsOnErrorPage = ERROR_PAGE_PATH.test(pathOf(finalUrl));
    const gone = status !== null && GONE_STATUSES.has(status);
    if (!hrefIsErrorPage && !landsOnErrorPage && !gone) continue;

    const where = link.hidden ? ' (inside a menu that is closed by default)' : '';
    const why = hrefIsErrorPage
      ? 'the link itself points to an error page'
      : gone
        ? `the other site answers HTTP ${status} (not found)`
        : `it redirects to an error page (${finalUrl})`;
    broken.push({ label: `"${link.text}"${where} → ${link.href} — ${why}`, verified: gone || hrefIsErrorPage });
  }

  if (broken.length === 0) {
    ctx.onLog('[UI] Links to other sites all point somewhere real');
    return;
  }
  ctx.onFinding({
    severity: 'low',
    area: 'UI-DeadLinks',
    title: `${broken.length} link(s) to other sites lead to an error page`,
    steps: [
      `Open ${pageUrl}`,
      'Find each link listed below by its text (open any closed menu first)',
      'Click it and look at the page that opens',
    ],
    expected: 'Links to other sites open a working page',
    actual: broken.map((b) => b.label).join('; '),
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: pageUrl.split('#')[0],
    confidence: broken.every((b) => b.verified) ? 'verified' : 'heuristic',
    confidenceReason:
      'Reads the address each link points to, and the other site\'s answer to one request. Blocked/rate-limited answers (401/403/429) are ignored, so bot-blocking sites are not reported.',
  });
}
