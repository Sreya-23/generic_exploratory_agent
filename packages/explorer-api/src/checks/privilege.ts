import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

export async function testPrivilegeEscalation(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
  flowClass: string,
  reportedPrivilegePaths: Set<string>,
): Promise<number> {
  // Prefer real discovered endpoints that look admin/role-flavored; a hardcoded
  // /api/admin against an app whose API lives elsewhere never matches anything.
  const fallbackPaths = ['/api/admin', '/api/users', '/api/settings'];
  const discovered = resolveEndpointPaths(ctx, []).filter((p) =>
    /admin|settings|role|permission|user/i.test(p),
  );
  const paths = (discovered.length > 0 ? discovered : fallbackPaths).slice(0, 5);

  // Vertical-privilege ("can a non-admin reach admin endpoints?") is only meaningful
  // when the session under test is NOT itself an admin-level account — otherwise
  // "admin can reach admin endpoints" isn't a finding, it's the account working as
  // designed. Without a second, genuinely low-privileged credential set, downgrade
  // rather than falsely flag a vulnerability.
  const usernameLooksPrivileged = /admin|root|super/i.test(ctx.config.credentials?.username ?? '');

  // Dedup key MUST include flowClass — horizontal-privilege and vertical-privilege probe
  // the same paths but are distinct checks; sharing a bare-path dedup set silently skipped
  // the second flow class entirely once the first had run. Filtered and marked synchronously
  // (no await in between), so this stays race-free once the probes below run concurrently.
  const pathsToProbe = paths.filter((path) => !reportedPrivilegePaths.has(`${flowClass}-${path}`));
  for (const path of pathsToProbe) reportedPrivilegePaths.add(`${flowClass}-${path}`);

  const hits = await mapWithConcurrency(pathsToProbe, 5, async (path) => {
    try {
      const { status, isJson, body } = await probe(baseUrl, { method: 'GET', path }, headers);

      if (status === 200 && isJson) {
        if (flowClass === 'vertical-privilege' && usernameLooksPrivileged) {
          ctx.onLog(
            `[Privilege] ${path} → 200 for account "${ctx.config.credentials?.username}" — this ` +
            `account already looks admin-level, so access here doesn't demonstrate privilege ` +
            `escalation; re-test with a genuinely low-privileged account for a conclusive result`,
          );
          return false;
        }
        const severity = flowClass === 'vertical-privilege' ? 'high' : 'medium';
        ctx.onFinding({
          severity,
          area: 'Security-Privilege',
          title: `Privileged JSON API endpoint accessible: ${path}`,
          steps: [
            flowClass === 'vertical-privilege'
              ? 'Use non-admin credentials'
              : 'Use another user\'s credentials',
            `GET ${path}`,
            'Check response is JSON and contains sensitive data',
          ],
          expected: '403 Forbidden — resource restricted to authorized roles',
          actual: `HTTP 200 with JSON data for ${path} — verify role-based access control`,
          evidence: writeApiEvidence(ctx, 'privilege-escalation', formatEvidence('GET', path, status, { responseBody: body })),
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      } else if (status === 200 && !isJson) {
        ctx.onLog(`[Privilege] ${path} → 200 but HTML (SPA catch-all) — not a real API endpoint, skipping`);
      } else if (status === 403 || status === 401) {
        ctx.onLog(`[Privilege] ${path} → ${status} — correctly protected`);
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
