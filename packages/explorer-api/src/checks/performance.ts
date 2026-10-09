import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

export async function testSpikeLoad(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Checklist §14 — Rapid API Requests/Burst Testing: previously always hit '/' (the site's
  // own homepage, not a real API), which tells you nothing about how the API itself handles a
  // burst. Targets a real discovered/guessed API endpoint instead, falling back to '/' only if
  // nothing else is known.
  const target = resolveEndpointPaths(ctx, []).find(Boolean) ?? '/';

  const SPIKE_COUNT = 50;
  ctx.onLog(`[SpikeLoad] Firing ${SPIKE_COUNT} concurrent requests at ${target}`);

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: SPIKE_COUNT }, () =>
      probe(baseUrl, { method: 'GET', path: target }, headers).catch(() => ({
        status: 0,
        body: '',
      })),
    ),
  );
  const elapsed = Date.now() - start;

  const errors = results.filter((r) => r.status === 0 || r.status >= 500);
  const rateLimited = results.filter((r) => r.status === 429);
  const successRate = ((results.length - errors.length) / results.length) * 100;

  ctx.onFinding({
    severity: errors.length > SPIKE_COUNT * 0.1 ? 'high' : successRate < 100 ? 'medium' : 'info',
    area: 'Performance-SpikeLoad',
    title: `Spike load (${SPIKE_COUNT} concurrent) on ${target}: ${successRate.toFixed(0)}% success`,
    steps: [`Fire ${SPIKE_COUNT} concurrent GET ${target} requests`],
    expected: '>95% success rate under spike load',
    actual: `Success: ${results.length - errors.length}/${SPIKE_COUNT}, Errors: ${errors.length}, Rate-limited: ${rateLimited.length}, Time: ${elapsed}ms`,
    evidence: writeApiEvidence(ctx, 'spike-load', formatEvidence('GET', target, 0, { responseBody: `Statuses: ${results.map((r) => r.status).join(',')}` })),
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: target,
  });

  return errors.length > 0 ? 1 : 0;
}

export async function testNPlusOne(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Detect N+1 by counting API calls made after loading a list page
  const listPaths = ['/api/users', '/api/items', '/api/products', '/api/orders'];
  let count = 0;

  for (const listPath of listPaths) {
    try {
      const res = await probe(baseUrl, { method: 'GET', path: listPath }, headers);
      if (res.status !== 200) continue;

      let items: unknown[];
      try {
        const parsed = JSON.parse(res.body);
        items = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.items ?? [];
      } catch {
        continue;
      }

      if (items.length < 2) continue;

      ctx.onFinding({
        severity: 'info',
        area: 'Performance-N+1',
        title: `List endpoint ${listPath} returns ${items.length} items — verify no N+1 queries`,
        steps: [`GET ${listPath}`, 'Count items in response', 'Check if individual item endpoints are called per item'],
        expected: 'Single query fetches all list data without per-item API calls',
        actual: `${items.length} items returned — monitor server-side query count for N+1 patterns`,
        evidence: writeApiEvidence(ctx, 'n-plus-one', formatEvidence('GET', listPath, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: false,
      });
      count++;
      break;
    } catch {
      /* ignore */
    }
  }
  return count;
}

export async function testLoadTime(baseUrl: string, ctx: ExecutorContext): Promise<number> {
  const start = Date.now();
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(30000) });
    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
      ctx.onFinding({
        severity: 'medium',
        area: 'Performance',
        title: `Slow initial load: ${(elapsed / 1000).toFixed(1)}s`,
        steps: [`GET ${baseUrl}`],
        expected: 'Load under 5s',
        actual: `${elapsed}ms`,
        evidence: writeApiEvidence(ctx, 'load-time', formatEvidence('GET', baseUrl, 0, { responseBody: `Elapsed: ${elapsed}ms` })),
        reproRate: '1/1',
        automationCandidate: true,
      });
      return 1;
    }
  } catch {
    /* ignore */
  }
  return 0;
}
