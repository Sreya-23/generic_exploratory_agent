import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, COMMON_PATHS } from '../probe-helpers.js';

export async function probeCommonEndpoints(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Prefer real endpoints from recon; fall back to generic guesses
  const pathsToProbe = resolveEndpointPaths(ctx, COMMON_PATHS);
  ctx.onLog(`[API] Probing ${pathsToProbe.length} endpoints on ${baseUrl}`);

  const hits = await mapWithConcurrency(pathsToProbe, 5, async (path) => {
    try {
      const { status, isJson, contentType } = await probe(baseUrl, { method: 'GET', path }, headers);
      ctx.onLog(`[API] GET ${path} → ${status} (${contentType.split(';')[0]})`);

      if (status === 200 && isJson) {
        ctx.onFinding({
          severity: 'info',
          area: 'API-Discovery',
          title: `Discovered JSON API endpoint: GET ${path}`,
          steps: [`GET ${path}`],
          expected: 'Endpoint exists',
          actual: `HTTP 200 with JSON response`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      } else if (status === 200 && !isJson) {
        ctx.onLog(`[API] GET ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
      }
    } catch {
      /* endpoint may not exist */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
