import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

// Checklist §25 — Sensitive Data Exposure. Deliberately narrow, high-confidence patterns only:
// a bare "password" field with a real value, or a recognizable secret-shaped string, is almost
// never appropriate in ANY API response regardless of endpoint — unlike e.g. an access_token
// in a login response, which is completely normal there and would false-positive constantly if
// matched context-free. Scoped to what's safe to assert without knowing the endpoint's purpose.
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /"password"\s*:\s*"(?!\s*$)[^"]+"/i, label: 'a raw "password" field with a non-empty value' },
  { pattern: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, label: 'a bcrypt password hash' },
  { pattern: /\$argon2(?:i|d|id)\$/, label: 'an argon2 password hash' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'an AWS access key ID' },
  { pattern: /"(?:db_password|database_url|connection_string)"\s*:\s*"[^"]+"/i, label: 'a database connection string/password' },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: 'a private key' },
  { pattern: /"(?:ssn|social_security_number)"\s*:\s*"\d{3}-?\d{2}-?\d{4}"/i, label: 'a raw SSN field' },
  { pattern: /"(?:card_number|cardNumber|cc_number)"\s*:\s*"?\d{13,19}"?/i, label: 'an unmasked card number field' },
];

// Checklist §28 — Caching Behaviour. The one caching anti-pattern that's safe to assert
// without understanding the endpoint's actual caching requirements: a response that LOOKS
// per-user (path contains /me, /profile, /account) but is cacheable by a SHARED cache
// (Cache-Control: public, no private/no-store) — a well-known real bug class (another user's
// private data served from a shared/CDN cache). Generic "could this be cached more/less" isn't
// something this check asserts an opinion on.
const PRIVATE_LOOKING_PATH = /\/(me|profile|account|self)\b/i;

export async function testResponseHygiene(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users/me', '/api/profile', '/api/account']).slice(0, 8);
  if (targets.length === 0) {
    ctx.onLog('[ResponseHygiene] No discovered/plausible endpoint to inspect — skipping');
    return 0;
  }

  let count = 0;
  let tracedCount = 0;
  let inspected = 0;

  for (const path of targets) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path }, headers);
    } catch {
      continue;
    }
    if (res.status !== 200 || !res.isJson) continue;
    inspected++;

    for (const { pattern, label } of SENSITIVE_PATTERNS) {
      if (pattern.test(res.body)) {
        ctx.onFinding({
          severity: 'high',
          area: 'API-SensitiveDataExposure',
          title: `Response appears to contain ${label}: GET ${path}`,
          steps: [`GET ${path}`, 'Inspect the raw response body'],
          expected: 'API responses should never include raw passwords, password hashes, private keys, or cloud credentials',
          actual: `Response body matches the pattern for ${label}`,
          evidence: writeApiEvidence(ctx, 'sensitive-data', formatEvidence('GET', path, res.status, { responseBody: res.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'heuristic',
          confidenceReason: 'Pattern-matched against the response text, not manually confirmed to be a real, currently-valid secret — verify before treating as confirmed, but patterns this specific are rarely false positives.',
        });
        count++;
      }
    }
  }

  // Caching check runs over the same discovered set — a separate GET per path isn't needed,
  // but the header check only makes sense paired with a path that LOOKS per-user, so it's kept
  // as its own loop for clarity rather than cramming both concerns into one pass.
  for (const path of targets.filter((p) => PRIVATE_LOOKING_PATH.test(p))) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path }, headers);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;

    const cacheControl = res.responseHeaders['cache-control'] ?? '';
    if (/\bpublic\b/i.test(cacheControl) && !/\b(private|no-store)\b/i.test(cacheControl)) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-Caching',
        title: `Per-user endpoint is cacheable by shared caches: GET ${path}`,
        steps: [`GET ${path} (while authenticated)`, 'Inspect the Cache-Control response header'],
        expected: 'A per-user endpoint should set Cache-Control: private or no-store, not public',
        actual: `Cache-Control: ${cacheControl} — a shared/CDN cache could serve this response to a different user`,
        evidence: writeApiEvidence(ctx, 'caching-shared', formatEvidence('GET', path, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'heuristic',
        confidenceReason: 'Flagged purely from the path looking per-user (/me, /profile, /account) — verify this endpoint genuinely returns data specific to the authenticated caller before treating as confirmed.',
      });
      count++;
    }
  }

  // Checklist §24/§32 — CORS misconfiguration. Sends a request with a clearly foreign Origin
  // and checks whether the response reflects it back permissively. The dangerous combination is
  // specifically credentialed + wildcard-or-reflected-origin — a non-credentialed wildcard CORS
  // response is completely normal for public APIs and is not flagged.
  const foreignOrigin = 'https://qa-cors-test-foreign-origin.example.com';
  let corsChecked = 0;
  for (const path of targets.slice(0, 4)) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path }, { ...headers, Origin: foreignOrigin });
    } catch {
      continue;
    }
    corsChecked++;
    const allowOrigin = res.responseHeaders['access-control-allow-origin'];
    const allowCreds = res.responseHeaders['access-control-allow-credentials'];
    if (allowOrigin && (allowOrigin === foreignOrigin || allowOrigin === '*') && allowCreds === 'true') {
      ctx.onFinding({
        severity: 'high',
        area: 'API-CORS',
        title: `CORS reflects an arbitrary Origin with credentials allowed: GET ${path}`,
        steps: [`GET ${path}`, `Header: Origin: ${foreignOrigin}`, 'Inspect Access-Control-Allow-Origin / Access-Control-Allow-Credentials response headers'],
        expected: 'Access-Control-Allow-Origin should be an explicit allow-list, never "*" or a reflected arbitrary origin, when Access-Control-Allow-Credentials is true',
        actual: `Access-Control-Allow-Origin: ${allowOrigin}, Access-Control-Allow-Credentials: ${allowCreds} for an origin that was never allow-listed`,
        evidence: writeApiEvidence(ctx, 'cors-misconfig', formatEvidence('GET', path, res.status, { requestHeaders: { Origin: foreignOrigin }, responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'verified',
        confidenceReason: 'Reflecting an arbitrary, never-registered origin while allowing credentials is unambiguous — any site can then read this response via a victim\'s authenticated browser.',
      });
      count++;
    }
  }

  // Checklist §28 — Caching Behaviour (ETag/conditional GET). If a response carries an ETag,
  // a follow-up GET with If-None-Match should return 304 Not Modified rather than re-sending the
  // full body — a generic, safe, GET-only check of whether conditional caching actually works.
  for (const path of targets.slice(0, 4)) {
    let first;
    try {
      first = await probe(baseUrl, { method: 'GET', path }, headers);
    } catch {
      continue;
    }
    const etag = first.responseHeaders['etag'];
    if (first.status !== 200 || !etag) continue;
    let second;
    try {
      second = await probe(baseUrl, { method: 'GET', path, headers: { 'If-None-Match': etag } }, headers);
    } catch {
      continue;
    }
    if (second.status !== 304) {
      ctx.onFinding({
        severity: 'low',
        area: 'API-Caching',
        title: `ETag present but conditional GET doesn't return 304: ${path}`,
        steps: [`GET ${path}`, `GET ${path} again with header: If-None-Match: ${etag}`],
        expected: 'An unchanged resource requested with a matching If-None-Match should return 304 Not Modified',
        actual: `HTTP ${second.status} — the server re-sent a full response instead of 304`,
        evidence: writeApiEvidence(ctx, 'etag-not-honored', formatEvidence('GET', path, second.status, { requestHeaders: { 'If-None-Match': etag }, responseBody: second.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'heuristic',
        confidenceReason: 'The resource may have genuinely changed between the two requests (e.g. a live counter) — verify it\'s actually static before treating as confirmed.',
      });
      count++;
    }
  }

  // Checklist §33 — API Observability: tracing-header presence, and §31 — Dependency Failure:
  // opportunistic detection only. This agent cannot make a real downstream dependency fail on
  // demand (no control over the target's own infrastructure) — but if a 502/503/504 shows up on
  // any of these already-planned requests, that's a real, organically-observed signal worth
  // surfacing rather than discarding.
  for (const path of targets) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path }, headers);
    } catch {
      continue;
    }
    if (res.status === 200) {
      if (['x-request-id', 'x-trace-id', 'x-correlation-id'].some((h) => res.responseHeaders[h])) tracedCount++;
    } else if ([502, 503, 504].includes(res.status)) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-DependencyFailure',
        title: `Upstream/dependency failure observed: GET ${path}`,
        steps: [`GET ${path}`],
        expected: 'A dependency failure should be rare and, when it happens, return a clear, bounded error — not a silent/opaque gateway error',
        actual: `HTTP ${res.status} — observed during routine exploration, not injected`,
        evidence: writeApiEvidence(ctx, 'dependency-failure', formatEvidence('GET', path, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: false,
        pageUrl: path,
        confidence: 'heuristic',
        confidenceReason: 'Opportunistically observed, not actively induced — this agent has no way to force a downstream dependency to fail on demand. Could be a transient blip; retry to confirm it recurs.',
      });
      count++;
    }
  }
  if (inspected > 0) {
    if (tracedCount === 0) {
      ctx.onFinding({
        severity: 'low',
        area: 'API-Observability',
        title: 'No request-tracing headers found on any inspected response',
        steps: targets.map((p) => `GET ${p}`),
        expected: 'Responses should carry a request-tracing header (x-request-id/x-trace-id/x-correlation-id) to support debugging and log correlation',
        actual: `0 of ${inspected} inspected response(s) carried any of x-request-id/x-trace-id/x-correlation-id`,
        evidence: [],
        reproRate: `0/${inspected}`,
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Many APIs rely on infrastructure-level tracing (e.g. a CDN/APM layer) not visible in this response header set — verify before treating as a genuine observability gap.',
      });
      count++;
    } else {
      ctx.onLog(
        `[ResponseHygiene] Inspected ${inspected} response(s) — ${tracedCount} carried a request-tracing header (x-request-id/x-trace-id/x-correlation-id)`,
      );
    }
  }
  if (corsChecked > 0) ctx.onLog(`[ResponseHygiene] Checked CORS behavior on ${corsChecked} endpoint(s)`);

  return count;
}
