import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence, COMMON_PATHS, PUBLIC_ENDPOINTS } from '../probe-helpers.js';

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
      const res = await probe(baseUrl, { method: 'GET', path }, {});

      if (res.status === 200 && res.isJson) {
        reportedAuthPaths.add(path);
        ctx.onFinding({
          severity: 'high',
          area: 'API-Auth',
          title: `Unauthenticated access to JSON API: ${path}`,
          steps: [`GET ${baseUrl}${path} without auth headers`],
          expected: 'HTTP 401 or 403',
          actual: `HTTP ${res.status} — returns JSON data without credentials`,
          evidence: writeApiEvidence(ctx, 'auth-no-token', formatEvidence('GET', path, res.status, { responseBody: res.body })),
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      } else if (res.status === 401 || res.status === 403) {
        ctx.onLog(`[API-Auth] ${path} → ${res.status} — correctly protected`);
      } else if (res.status === 200 && !res.isJson) {
        ctx.onLog(`[API-Auth] ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}

/**
 * Checklist §2 — token-shaped auth bypass attempts, distinct from testAuthMatrix's "no token at
 * all" case. Sends the same protected endpoints a battery of FAKE credentials that should never
 * be accepted: a garbage bearer value, a non-JWT-shaped string, and a syntactically-JWT-shaped
 * but unsigned token carrying an already-expired `exp` claim. None of these are real tokens for
 * this site, so there's no account risk — the only thing being tested is whether the server
 * actually validates the token rather than just checking "is an Authorization header present."
 *
 * Deliberately NOT implemented here (would need app-specific knowledge this generic agent
 * doesn't have): testing a genuinely-logged-out token (no generic way to invalidate a real
 * session token mid-test without risking the real logged-in session needed for the rest of the
 * run), and token refresh is only tested when a refresh-shaped endpoint is actually discovered
 * (see testTokenRefresh below) — guessing one blind would be pure noise.
 */
const FAKE_TOKENS: Array<{ label: string; value: string }> = [
  { label: 'invalid', value: 'invalid-token-qa-test-00000000' },
  { label: 'malformed', value: 'not a valid bearer token at all' },
  {
    label: 'expired-shaped-jwt',
    // header {"alg":"HS256","typ":"JWT"} . payload {"sub":"qa","exp":1000000000} (year 2001) . garbage signature
    value:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxYSIsImV4cCI6MTAwMDAwMDAwMH0.qa-garbage-signature-00000000',
  },
];

export async function testTokenValidation(
  baseUrl: string,
  ctx: ExecutorContext,
  reportedTokenPaths: Set<string>,
): Promise<number> {
  const fallbackPaths = COMMON_PATHS.filter((p) => !PUBLIC_ENDPOINTS.has(p));
  const pathsToTest = resolveEndpointPaths(ctx, fallbackPaths).slice(0, 3);
  const toTest = pathsToTest.filter((p) => !reportedTokenPaths.has(p));
  if (toTest.length === 0) return 0;

  let count = 0;
  for (const path of toTest) {
    for (const fake of FAKE_TOKENS) {
      let res;
      try {
        res = await probe(baseUrl, { method: 'GET', path, headers: { Authorization: `Bearer ${fake.value}` } }, {});
      } catch {
        continue;
      }
      if (res.status === 200 && res.isJson) {
        reportedTokenPaths.add(path);
        ctx.onFinding({
          severity: 'critical',
          area: 'API-Auth',
          title: `${fake.label} token accepted as valid: ${path}`,
          steps: [`GET ${baseUrl}${path}`, `Authorization: Bearer <${fake.label} token — never issued by this site>`],
          expected: 'A fake/invalid/expired token should return 401 or 403',
          actual: `HTTP ${res.status} — returned JSON data for a ${fake.label} token`,
          evidence: writeApiEvidence(
            ctx,
            `auth-${fake.label}`,
            formatEvidence('GET', path, res.status, {
              requestHeaders: { Authorization: `Bearer ${fake.value}` },
              responseBody: res.body,
            }),
          ),
          reproRate: '1/1',
          automationCandidate: true,
          confidence: 'verified',
          confidenceReason: 'This exact token value was never issued by the site — any 200+JSON response to it is unambiguous.',
        });
        count++;
        break; // one confirmed bypass per path is enough signal; move to the next path
      }
    }
  }
  if (count === 0) {
    ctx.onLog(`[API-Auth] Checked ${toTest.length} endpoint(s) against invalid/malformed/expired-shaped tokens — all correctly rejected`);
  }
  return count;
}

/**
 * Checklist §2 — token refresh testing. Conditional: only runs if a refresh-shaped endpoint is
 * actually discovered (path containing "refresh"). Fires two simultaneous refresh calls with
 * identical stored session cookies to check whether the server's refresh-token rotation has a
 * race window that lets the same refresh credential mint two independent new sessions at once —
 * a generic, safe thing to check since it reuses the session's OWN already-authenticated state
 * rather than guessing/fabricating any credential.
 */
export async function testTokenRefresh(
  baseUrl: string,
  ctx: ExecutorContext,
  headers: Record<string, string>,
): Promise<number> {
  const discovered = (ctx.discoveredApiEndpoints ?? [])
    .map((e) => { try { const parts = e.split(' '); const u = parts[1] ?? parts[0]; return u.startsWith('http') ? new URL(u).pathname : u; } catch { return null; } })
    .filter((p): p is string => typeof p === 'string' && /refresh/i.test(p));
  const refreshPath = [...new Set(discovered)][0];
  if (!refreshPath) {
    ctx.onLog('[API-Auth] No refresh-shaped endpoint discovered — skipping token refresh testing');
    return 0;
  }

  let results: Array<{ status: number; body: string }> = [];
  try {
    results = await Promise.all([
      probe(baseUrl, { method: 'POST', path: refreshPath }, headers),
      probe(baseUrl, { method: 'POST', path: refreshPath }, headers),
    ]);
  } catch {
    return 0;
  }
  const succeeded = results.filter((r) => r.status >= 200 && r.status < 300);
  if (succeeded.length === 2) {
    const tokens = succeeded.map((r) => {
      try { return JSON.parse(r.body)?.accessToken ?? JSON.parse(r.body)?.token ?? null; } catch { return null; }
    }).filter(Boolean);
    if (tokens.length === 2 && tokens[0] !== tokens[1]) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-Auth',
        title: `Simultaneous refresh requests both succeed with different tokens: ${refreshPath}`,
        steps: [`Fire 2 simultaneous POST ${refreshPath} requests using the same authenticated session`],
        expected: 'Concurrent refresh attempts should either both return the same token, or only one should succeed',
        actual: 'Both concurrent requests succeeded and returned two different new tokens',
        evidence: writeApiEvidence(ctx, 'auth-refresh-race', formatEvidence('POST', refreshPath, 200, { responseBody: `Response 1: ${succeeded[0].body}\nResponse 2: ${succeeded[1].body}` })),
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Some providers intentionally allow multiple valid tokens per session (multi-device) — verify this is actually unintended before treating as confirmed.',
      });
      return 1;
    }
  }
  ctx.onLog(`[API-Auth] ${refreshPath}: concurrent refresh check ran, no inconsistency detected`);
  return 0;
}

/**
 * Checklist §32 — JWT alg-confusion ("alg":"none"). Conditional: only runs if the session is
 * actually using a real bearer JWT (three dot-separated base64url segments). Re-signs the
 * caller's OWN real token with alg:none and an empty signature — not a forged token for anyone
 * else, just a structural variant of the token already legitimately in use this session — and
 * checks whether the server still accepts it. A well-known, high-impact class of bug: if the
 * server only checks the header's claimed algorithm instead of enforcing one server-side, "none"
 * bypasses signature verification entirely.
 */
export async function testJwtAlgConfusion(
  baseUrl: string,
  ctx: ExecutorContext,
  headers: Record<string, string>,
): Promise<number> {
  const authHeader = headers.Authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) {
    ctx.onLog('[API-Auth] No bearer JWT in use this session — skipping alg-confusion check');
    return 0;
  }

  let payloadStr: string;
  try {
    payloadStr = parts[1];
  } catch {
    return 0;
  }
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const noneToken = `${noneHeader}.${payloadStr}.`;

  const fallbackPaths = resolveEndpointPaths(ctx, COMMON_PATHS).slice(0, 3);
  let count = 0;
  for (const path of fallbackPaths) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path, headers: { Authorization: `Bearer ${noneToken}` } }, {});
    } catch {
      continue;
    }
    if (res.status === 200 && res.isJson) {
      ctx.onFinding({
        severity: 'critical',
        area: 'API-Auth',
        title: `JWT "alg":"none" accepted — signature verification bypass: ${path}`,
        steps: [
          `Take the session's own valid JWT and re-encode its header as {"alg":"none","typ":"JWT"} with an empty signature`,
          `GET ${path}`,
        ],
        expected: 'A token claiming alg:none must be rejected — the server must enforce its own expected signing algorithm, never trust the token header',
        actual: `HTTP ${res.status} — the server accepted an unsigned token`,
        evidence: writeApiEvidence(ctx, 'jwt-alg-none', formatEvidence('GET', path, res.status, { requestHeaders: { Authorization: `Bearer ${noneToken}` }, responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'verified',
        confidenceReason: 'An unsigned token being accepted as valid is unambiguous — this is a complete authentication bypass.',
      });
      count++;
      break;
    }
  }
  if (count === 0) {
    ctx.onLog('[API-Auth] alg:none token was correctly rejected');
  }
  return count;
}
