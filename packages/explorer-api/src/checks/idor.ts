import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

export async function testIdor(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Real IDOR signal requires probing real collection endpoints with the authenticated
  // session attached (buildHeaders already includes it when available) — a hardcoded
  // /api/users/{id} against an app whose API lives elsewhere just 404s forever and
  // proves nothing either way.
  const hasSession = Boolean(headers.Cookie || headers.Authorization || headers['X-API-Key']);
  const collectionPaths = resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
  const idsToTry = ['1', '2', '3', '999', '0'];
  let count = 0;

  for (const collectionPath of collectionPaths) {
    const base = collectionPath.replace(/\/$/, '');

    const results = (
      await mapWithConcurrency(idsToTry, 5, async (id) => {
        try {
          const path = `${base}/${id}`;
          const { status, isJson, body } = await probe(baseUrl, { method: 'GET', path }, headers);
          return { id, status, isJson, body };
        } catch {
          return null;
        }
      })
    ).filter((r): r is { id: string; status: number; isJson: boolean; body: string } => r !== null);

    const okResults = results.filter((r) => r.status === 200 && r.isJson);
    const blockedResults = results.filter((r) => r.status === 401 || r.status === 403);

    if (okResults.length >= 2) {
      const distinctBodies = new Set(okResults.map((r) => r.body)).size;
      ctx.onFinding({
        severity: hasSession ? 'medium' : 'info',
        area: 'API-Security',
        title: `${base}/{id} returns data for ${okResults.length} different IDs (${distinctBodies} distinct response${distinctBodies === 1 ? '' : 's'})`,
        steps: okResults.map((r) => `GET ${base}/${r.id}`),
        expected: hasSession
          ? "Only records the authenticated user's role is authorized for should be returned"
          : 'Resource-by-ID access should require authentication',
        actual: hasSession
          ? `The logged-in session fetched ${okResults.length} different records by ID — verify this account's role legitimately has access to all of them; re-test with a lower-privileged account for a conclusive IDOR verdict`
          : `HTTP 200 with JSON returned for ${okResults.length} IDs with no authentication at all`,
        evidence: writeApiEvidence(ctx, 'idor-multi-id', formatEvidence('GET', `${base}/{id}`, 200, { responseBody: okResults.map((r) => `${r.id}: ${r.body}`).join('\n---\n') })),
        reproRate: '1/1',
        automationCandidate: true,
      });
      count++;
    }

    if (okResults.length > 0 && blockedResults.length > 0) {
      ctx.onFinding({
        severity: 'high',
        area: 'API-Security',
        title: `Inconsistent authorization on ${base}/{id} — some IDs allowed, others blocked`,
        steps: [
          ...okResults.map((r) => `GET ${base}/${r.id} → ${r.status}`),
          ...blockedResults.map((r) => `GET ${base}/${r.id} → ${r.status}`),
        ],
        expected: 'Consistent authorization behaviour across resource IDs of the same type',
        actual: `${okResults.length} ID(s) returned 200, ${blockedResults.length} ID(s) returned 401/403 for the same session — inconsistent access control`,
        evidence: writeApiEvidence(ctx, 'idor-inconsistent-auth', formatEvidence('GET', `${base}/{id}`, 0, { responseBody: `Allowed: ${okResults.map((r) => r.id).join(',')}\nBlocked: ${blockedResults.map((r) => r.id).join(',')}` })),
        reproRate: '1/1',
        automationCandidate: true,
      });
      count++;
    }
  }

  return count;
}
