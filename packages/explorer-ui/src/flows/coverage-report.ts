import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { getVisitedPaths, clearVisitTracking } from './page-visit-tracker.js';

// §2 — orphan-page detection: a page the site itself advertises (via sitemap.xml) but that the
// crawl never found a link to at all. Evidence-based (the site's own sitemap), not a guess —
// same discipline as hidden-route-access.ts only ever following real, discovered hrefs.
const SITEMAP_LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

async function fetchSitemapPages(origin: string): Promise<string[]> {
  const sitemapUrls = new Set([`${origin}/sitemap.xml`]);
  try {
    const robotsRes = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (robotsRes.ok) {
      const text = await robotsRes.text();
      for (const m of text.matchAll(/^sitemap:\s*(\S+)/gim)) sitemapUrls.add(m[1]);
    }
  } catch {
    /* robots.txt absent/unreachable — not unusual, not an error */
  }

  const found = new Set<string>();
  for (const sitemapUrl of sitemapUrls) {
    try {
      const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      for (const m of text.matchAll(SITEMAP_LOC_PATTERN)) {
        try {
          const u = new URL(m[1].trim());
          if (u.origin === origin) found.add(u.origin + u.pathname);
        } catch {
          /* malformed <loc> entry */
        }
      }
    } catch {
      /* this candidate sitemap URL is absent/unreachable — try the next one silently */
    }
  }
  return [...found];
}

// Runs last (report phase) so it can answer, with real numbers, the question this agent kept
// getting asked without a good answer: "were the tabs/sidebar/routes actually explored, and
// how would I check?" — turns scattered per-flow log lines into one explicit ratio plus a
// named list of what was skipped.
export async function runCoverageReport(
  _page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const visited = new Set(getVisitedPaths(ctx.sessionId));
  ctx.visitedRoutes = [...visited];

  const discovered = ctx.discoveredRoutes ?? [];
  if (discovered.length === 0) {
    ctx.onLog(
      `[Coverage] ${visited.size} distinct route(s) visited this session (no landing-page route ` +
        'list from recon to compare against, so no coverage ratio)',
    );
    clearVisitTracking(ctx.sessionId);
    return;
  }

  const notVisited = discovered.filter((r) => !visited.has(r));
  const visitedCount = discovered.length - notVisited.length;
  ctx.onLog(
    `[Coverage] ${visitedCount}/${discovered.length} discovered route(s) explored` +
      (notVisited.length > 0 ? ` — not visited: ${notVisited.slice(0, 10).join(', ')}` : ''),
  );

  const origin = new URL(ctx.config.targetUrl).origin;
  const sitemapPages = await fetchSitemapPages(origin).catch(() => [] as string[]);
  if (sitemapPages.length === 0) {
    ctx.onLog('[Coverage] No sitemap.xml found (or empty) — orphan-page check skipped');
  } else {
    const discoveredSet = new Set(discovered);
    const orphans = sitemapPages.filter((p) => !discoveredSet.has(p));
    if (orphans.length > 0) {
      ctx.onFinding({
        severity: 'low',
        area: 'Coverage',
        title: `${orphans.length} page(s) listed in sitemap.xml have no discoverable link from the crawled UI`,
        steps: [`Compare ${origin}/sitemap.xml against links actually found while crawling the site`],
        expected: 'Every page the site advertises via its sitemap should be reachable through actual UI navigation',
        actual: `Orphan page(s) (in sitemap, no link found): ${orphans.slice(0, 10).join(', ')}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: "A sitemap entry with no discovered link could be a real orphan page, or simply a page this crawl's depth/budget didn't reach — verify no nav path to it exists at all before treating as confirmed.",
      });
    } else {
      ctx.onLog(`[Coverage] All ${sitemapPages.length} sitemap page(s) have a discoverable link from the crawl`);
    }
  }

  clearVisitTracking(ctx.sessionId);
}
