import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, COMMON_PATHS, PUBLIC_ENDPOINTS } from '../probe-helpers.js';

export async function testAuthMatrix(
  baseUrl: string,
  ctx: ExecutorContext,
  headers: Record<string, string>,
  reportedAuthPaths: Set<string>,
): Promise<number> {
  // Use real discovered endpoints; fall back to guesses minus known-public health endpoints
  const fallbackPaths = COMMON_PATHS.filter((p) => !PUBLIC_ENDPOINTS.has(p));
  const pathsToTest = resolveEndpointPaths(ctx, fallbackPaths).slice(0, 5);

  const toTest = pathsToTest.filter((p) => !reportedAuthPaths.has(p));
  const hits = await mapWithConcurrency(toTest, 5, async (path) => {
    try {
      // Test without ANY auth headers to check if endpoint is truly protected
      const { status, isJson } = await probe(baseUrl, { method: 'GET', path }, {});

      if (status === 200 && isJson) {
        reportedAuthPaths.add(path);
        ctx.onFinding({
          severity: 'high',
          area: 'API-Auth',
          title: `Unauthenticated access to JSON API: ${path}`,
          steps: [`GET ${baseUrl}${path} without auth headers`],
          expected: 'HTTP 401 or 403',
          actual: `HTTP ${status} — returns JSON data without credentials`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      } else if (status === 401 || status === 403) {
        ctx.onLog(`[API-Auth] ${path} → ${status} — correctly protected`);
      } else if (status === 200 && !isJson) {
        ctx.onLog(`[API-Auth] ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
