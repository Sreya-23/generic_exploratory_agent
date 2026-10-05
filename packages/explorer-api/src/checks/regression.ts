import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency } from '../probe-helpers.js';

export async function testSchemaDrift(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const endpoints = [
    { path: '/api/users/me', requiredFields: ['id', 'email'] },
    { path: '/api/health', requiredFields: ['status'] },
    { path: '/api', requiredFields: [] },
  ];

  const hits = await mapWithConcurrency(endpoints, 5, async (ep) => {
    try {
      const { status, body } = await probe(baseUrl, { method: 'GET', path: ep.path }, headers);
      if (status !== 200) return false;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        return false;
      }

      const missing = ep.requiredFields.filter((f) => !(f in parsed));
      if (missing.length > 0) {
        ctx.onFinding({
          severity: 'medium',
          area: 'Regression-Schema',
          title: `API schema drift: missing fields in ${ep.path}`,
          steps: [`GET ${ep.path}`, 'Check response for required fields'],
          expected: `Fields present: ${ep.requiredFields.join(', ')}`,
          actual: `Missing fields: ${missing.join(', ')}`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      } else if (ep.requiredFields.length > 0) {
        ctx.onLog(`[SchemaDrift] ${ep.path} — all expected fields present`);
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
