import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths } from '../probe-helpers.js';

export async function testPagination(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const edgeCases = ['?page=0', '?page=-1', '?page=99999', '?limit=10000'];
  const basePaths = resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
  const combos = basePaths.flatMap((basePath) => edgeCases.map((query) => ({ basePath, query })));

  const hits = await mapWithConcurrency(combos, 5, async ({ basePath, query }) => {
    try {
      const { status, body } = await probe(
        baseUrl,
        { method: 'GET', path: `${basePath}${query}` },
        headers,
      );
      if (status >= 500) {
        ctx.onFinding({
          severity: 'medium',
          area: 'API-Boundary',
          title: `Server error on pagination edge case: ${basePath}${query}`,
          steps: [`GET ${basePath}${query}`],
          expected: '4xx client error for invalid pagination',
          actual: `HTTP ${status}: ${body.slice(0, 100)}`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
