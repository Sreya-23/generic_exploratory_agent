import type { ExecutorContext } from '@qa/shared';
import { probe } from '../probe-helpers.js';

// Rate limiting is a meaningful control on endpoints an attacker actually wants to hammer —
// login, OTP/send-code, password reset, signup, search — not on a public homepage or a
// read-only listing endpoint, which most real architectures never rate-limit and don't need
// to. Testing the wrong kind of endpoint and calling the result a security gap is exactly
// why this finding kept getting dismissed as "not required for this" — the check needs to
// go looking for a target that's actually worth protecting.
const SENSITIVE_ENDPOINT_PATTERN =
  /login|signin|sign-in|auth|otp|verify|token|password|reset|forgot|signup|sign-up|register|search/i;

// Testing every sensitive-looking endpoint individually, not just the first match — a real
// app can easily have several worth checking independently (login, OTP verify, password
// reset, search all being separately exploitable). Capped so one session doesn't turn into
// an unbounded number of 20-request bursts.
const MAX_SENSITIVE_ENDPOINTS_TO_TEST = 5;

async function probeOneRateLimitTarget(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
  probeMethod: 'GET' | 'POST',
  probePath: string,
  isSensitiveTarget: boolean,
): Promise<number> {
  ctx.onLog(`[RateLimit] Sending 20 rapid ${probeMethod} ${probePath} to ${baseUrl}`);

  const requests = Array.from({ length: 20 }, () =>
    probe(baseUrl, { method: probeMethod, path: probePath }, headers).catch(() => ({
      status: 0,
      body: '',
    })),
  );
  const results = await Promise.all(requests);
  const rateLimited = results.some((r) => r.status === 429);
  const statuses = [...new Set(results.map((r) => r.status))].join(', ');

  ctx.onLog(`[RateLimit] Results for ${probePath}: ${results.length} requests, statuses seen: ${statuses}`);

  if (!rateLimited) {
    ctx.onFinding({
      // A generic public/read-only endpoint not being rate-limited is common and often by
      // design — not worth reporting as a defect. A genuinely sensitive endpoint (login,
      // OTP, password reset) with no rate limiting is a real, actionable gap.
      severity: isSensitiveTarget ? 'medium' : 'info',
      area: 'API-RateLimit',
      title: isSensitiveTarget
        ? `No rate limiting on sensitive endpoint after 20 rapid requests: ${probeMethod} ${probePath}`
        : `No rate limiting detected on generic endpoint after 20 rapid requests to ${probePath}`,
      steps: [`Send 20 concurrent ${probeMethod} ${probePath} to ${baseUrl}`],
      expected: isSensitiveTarget
        ? 'Sensitive endpoints (auth, OTP, password reset, search) should return HTTP 429 after a burst threshold to prevent brute-force/abuse'
        : 'HTTP 429 after burst threshold (informational — many public/read-only endpoints are not rate-limited by design)',
      actual: `No 429 observed. Statuses: ${statuses}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: isSensitiveTarget ? 'verified' : 'heuristic',
      confidenceReason: isSensitiveTarget
        ? 'Tested against a real, discovered endpoint matching known abuse-prone patterns (auth/OTP/reset/search) — a genuine target rate limiting is meant to protect.'
        : 'No sensitive endpoint was discovered this run — tested a generic/public path instead, where missing rate limiting is common and often not a real requirement.',
    });
    return 1;
  }

  ctx.onLog(`[RateLimit] Rate limiting active on ${probePath} — OK`);
  return 0;
}

export async function testRateLimit(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Prefer REAL, discovered endpoints (from recon's captured network traffic) that look
  // sensitive over a generic guessed path — this is the same discoveredApiEndpoints pool
  // API-Discovery findings are built from, now put to use for something that actually
  // benefits from real endpoints instead of guesses.
  const discovered = ctx.discoveredApiEndpoints ?? [];
  const sensitiveDiscovered = [
    ...new Set(discovered.filter((e) => SENSITIVE_ENDPOINT_PATTERN.test(e))),
  ].slice(0, MAX_SENSITIVE_ENDPOINTS_TO_TEST);

  if (sensitiveDiscovered.length > 0) {
    ctx.onLog(
      `[RateLimit] Found ${sensitiveDiscovered.length} real, sensitive discovered endpoint(s) to test: ${sensitiveDiscovered.join(', ')}`,
    );
    let count = 0;
    for (const entry of sensitiveDiscovered) {
      const [method, path] = entry.split(' ');
      count += await probeOneRateLimitTarget(
        baseUrl,
        headers,
        ctx,
        method === 'POST' ? 'POST' : 'GET',
        path,
        true,
      );
    }
    return count;
  }

  // No sensitive endpoint discovered on this run — fall back to a generic API-like path
  // purely as a coarse infrastructure sanity check, not a claimed security gap.
  const candidatePaths = ['/api/v1', '/api', '/api/status', '/api/health'];
  let probePath: string | null = null;
  for (const p of candidatePaths) {
    try {
      const { status, isJson } = await probe(baseUrl, { method: 'GET', path: p }, headers);
      if (status !== 404 && status !== 0 && isJson) {
        probePath = p;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!probePath) {
    ctx.onLog('[RateLimit] No sensitive endpoint discovered and no generic API path responded — skipping (nothing meaningful to rate-limit test)');
    return 0;
  }

  return probeOneRateLimitTarget(baseUrl, headers, ctx, 'GET', probePath, false);
}
