import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BaseExecutor,
  ExecutorContext,
  ExecutorResult,
  ExplorationArea,
  FlowTask,
} from '@qa/shared';

/**
 * Whether `field` actually comes back set to `value` in the response — NOT just whether
 * `value`'s raw text happens to appear anywhere in the body. A bare substring check
 * (the previous approach) false-positives hard on any endpoint that returns boilerplate
 * like {"success":true} for every request regardless of what was sent: probing isAdmin=true
 * or verified=true would "match" on that unrelated success flag, not on the field being
 * reflected at all. Parses JSON and checks the field (top-level or one level nested, since
 * APIs commonly wrap the payload in data/user/result) against the actual value with type
 * awareness; falls back to a key-near-value regex only for non-JSON bodies.
 */
function reflectsField(body: string, field: string, value: string | number | boolean): boolean {
  try {
    const parsed = JSON.parse(body);
    if (objectHasField(parsed, field, value)) return true;
    for (const key of ['data', 'user', 'result', 'profile']) {
      const nested = (parsed as Record<string, unknown>)?.[key];
      if (nested && typeof nested === 'object' && objectHasField(nested, field, value)) return true;
    }
    return false;
  } catch {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`["']?${escapedField}["']?\\s*[:=]\\s*["']?${escapedValue}\\b`, 'i').test(body);
  }
}

function objectHasField(obj: unknown, field: string, value: string | number | boolean): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const actual = (obj as Record<string, unknown>)[field];
  return actual !== undefined && String(actual) === String(value);
}

interface ApiProbe {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Extract the logged-in session cookie from Playwright's saved storageState, so
 * API probes hit real endpoints AS the authenticated user rather than as an
 * anonymous caller. Without this, every probe below is unauthenticated regardless
 * of the site's login method — for cookie-session apps (the common case for
 * password logins) that makes IDOR/privilege/mass-assignment checks meaningless,
 * since a correctly-protected endpoint just 401s the same way an insecure one
 * would look to a genuinely unauthenticated caller.
 */
function readSessionCookieHeader(ctx: ExecutorContext): string | null {
  try {
    const stateFile = join(ctx.sessionsDir, ctx.sessionId, 'auth-state.json');
    if (!existsSync(stateFile)) return null;
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { cookies?: StoredCookie[] };
    const origin = new URL(ctx.config.targetUrl).hostname;
    const relevant = (state.cookies ?? []).filter(
      (c) => origin === c.domain || origin.endsWith(c.domain.replace(/^\./, '')),
    );
    if (relevant.length === 0) return null;
    return relevant.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

function buildHeaders(ctx: ExecutorContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const creds = ctx.config.credentials;
  if (creds?.type === 'bearer' && creds.bearerToken) {
    headers.Authorization = `Bearer ${creds.bearerToken}`;
  } else if (creds?.type === 'api-key' && creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }
  const cookieHeader = readSessionCookieHeader(ctx);
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

async function probe(
  baseUrl: string,
  p: ApiProbe,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; isJson: boolean; contentType: string }> {
  const url = new URL(p.path, baseUrl).toString();
  const res = await fetch(url, {
    method: p.method,
    headers: { ...headers, ...p.headers },
    body: p.body ? JSON.stringify(p.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text().catch(() => '');
  // Determine if this is actually a JSON API response vs SPA catch-all HTML
  const isJson =
    contentType.includes('application/json') ||
    (body.trimStart().startsWith('{') || body.trimStart().startsWith('['));
  return { status: res.status, body: body.slice(0, 500), isJson, contentType };
}

// Public endpoints that are intentionally unauthenticated — should never be flagged HIGH
const PUBLIC_ENDPOINTS = new Set(['/health', '/api/health', '/api/status', '/ping', '/api/ping', '/status']);

const COMMON_PATHS = ['/api', '/api/v1', '/api/health', '/health', '/api/users', '/api/status'];

export class ApiExecutor implements BaseExecutor {
  name = 'api';
  areas: ExplorationArea[] = ['api', 'security', 'performance'];

  async execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult> {
    let findingsCount = 0;

    // Always use the site ORIGIN — strip path/login suffix from targetUrl
    // e.g. "https://web.dev.cofee.life/login" → "https://web.dev.cofee.life"
    const baseUrl = (() => {
      try { return new URL(ctx.config.targetUrl).origin; } catch { return ctx.config.targetUrl; }
    })();

    const headers = buildHeaders(ctx);

    ctx.onLog(`[API] Starting: ${task.title}`);

    try {
      if (task.flowClass === 'crud' || task.flowClass === 'boundary') {
        findingsCount += await this.probeCommonEndpoints(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'auth-matrix' || task.flowClass === 'auth-bypass') {
        findingsCount += await this.testAuthMatrix(baseUrl, ctx, headers);
      }

      if (task.flowClass === 'pagination') {
        findingsCount += await this.testPagination(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'idor-probe') {
        findingsCount += await this.testIdor(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'rate-limit') {
        findingsCount += await this.testRateLimit(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'load-time') {
        findingsCount += await this.testLoadTime(baseUrl, ctx);
      }

      if (task.flowClass === 'horizontal-privilege' || task.flowClass === 'vertical-privilege') {
        findingsCount += await this.testPrivilegeEscalation(baseUrl, headers, ctx, task.flowClass);
      }

      if (task.flowClass === 'mass-assignment') {
        findingsCount += await this.testMassAssignment(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'xss-probe') {
        findingsCount += await this.testXssProbe(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'spike-load') {
        findingsCount += await this.testSpikeLoad(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'n-plus-one') {
        findingsCount += await this.testNPlusOne(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'schema-drift') {
        findingsCount += await this.testSchemaDrift(baseUrl, headers, ctx);
      }

      return { taskId: task.id, success: true, findingsCount };
    } catch (err) {
      return {
        taskId: task.id,
        success: false,
        findingsCount,
        error: (err as Error).message,
      };
    }
  }

  // Track which auth findings have already been reported to prevent duplicates
  // (auth-matrix and auth-bypass both run testAuthMatrix)
  private reportedAuthPaths = new Set<string>();
  private reportedPrivilegePaths = new Set<string>();

  private async probeCommonEndpoints(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    let count = 0;

    // Prefer real endpoints from recon; fall back to generic guesses
    const pathsToProbe = this.resolveEndpointPaths(ctx, COMMON_PATHS);
    ctx.onLog(`[API] Probing ${pathsToProbe.length} endpoints on ${baseUrl}`);

    for (const path of pathsToProbe) {
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
          count++;
        } else if (status === 200 && !isJson) {
          ctx.onLog(`[API] GET ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
        }
      } catch {
        /* endpoint may not exist */
      }
    }
    return count;
  }

  private async testAuthMatrix(
    baseUrl: string,
    ctx: ExecutorContext,
    headers: Record<string, string>,
  ): Promise<number> {
    let count = 0;

    // Use real discovered endpoints; fall back to guesses minus known-public health endpoints
    const fallbackPaths = COMMON_PATHS.filter((p) => !PUBLIC_ENDPOINTS.has(p));
    const pathsToTest = this.resolveEndpointPaths(ctx, fallbackPaths).slice(0, 5);

    for (const path of pathsToTest) {
      if (this.reportedAuthPaths.has(path)) continue; // Deduplicate

      try {
        // Test without ANY auth headers to check if endpoint is truly protected
        const { status, isJson } = await probe(baseUrl, { method: 'GET', path }, {});

        if (status === 200 && isJson) {
          this.reportedAuthPaths.add(path);
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
          count++;
        } else if (status === 401 || status === 403) {
          ctx.onLog(`[API-Auth] ${path} → ${status} — correctly protected`);
        } else if (status === 200 && !isJson) {
          ctx.onLog(`[API-Auth] ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
        }
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  /**
   * Returns paths to probe, preferring those actually discovered by recon
   * from the site's real network traffic. Falls back to generic guesses only
   * when recon found nothing.
   */
  private resolveEndpointPaths(ctx: ExecutorContext, fallback: string[]): string[] {
    const discovered = ctx.discoveredApiEndpoints ?? [];
    if (discovered.length > 0) {
      // Extract just the path portion from "GET https://..." or "GET /path"
      const paths = discovered.map((e) => {
        try {
          const parts = e.split(' ');
          const urlPart = parts[1] ?? parts[0];
          return urlPart.startsWith('http') ? new URL(urlPart).pathname : urlPart;
        } catch { return null; }
      }).filter((p): p is string => Boolean(p) && p !== '/');

      const unique = [...new Set(paths)].slice(0, 10);
      if (unique.length > 0) {
        ctx.onLog(`[API] Using ${unique.length} recon-discovered endpoints instead of generic guesses`);
        return unique;
      }
    }
    ctx.onLog(`[API] No recon endpoints available — using ${fallback.length} generic path guesses`);
    return fallback;
  }

  private async testPagination(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const edgeCases = ['?page=0', '?page=-1', '?page=99999', '?limit=10000'];
    const basePaths = this.resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
    let count = 0;

    for (const basePath of basePaths) {
      for (const query of edgeCases) {
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
            count++;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return count;
  }

  private async testIdor(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    // Real IDOR signal requires probing real collection endpoints with the authenticated
    // session attached (buildHeaders already includes it when available) — a hardcoded
    // /api/users/{id} against an app whose API lives elsewhere just 404s forever and
    // proves nothing either way.
    const hasSession = Boolean(headers.Cookie || headers.Authorization || headers['X-API-Key']);
    const collectionPaths = this.resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
    const idsToTry = ['1', '2', '3', '999', '0'];
    let count = 0;

    for (const collectionPath of collectionPaths) {
      const base = collectionPath.replace(/\/$/, '');
      const results: Array<{ id: string; status: number; isJson: boolean; body: string }> = [];

      for (const id of idsToTry) {
        try {
          const path = `${base}/${id}`;
          const { status, isJson, body } = await probe(baseUrl, { method: 'GET', path }, headers);
          results.push({ id, status, isJson, body });
        } catch {
          /* ignore */
        }
      }

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
          evidence: [],
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
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        count++;
      }
    }

    return count;
  }

  // Rate limiting is a meaningful control on endpoints an attacker actually wants to hammer —
  // login, OTP/send-code, password reset, signup, search — not on a public homepage or a
  // read-only listing endpoint, which most real architectures never rate-limit and don't need
  // to. Testing the wrong kind of endpoint and calling the result a security gap is exactly
  // why this finding kept getting dismissed as "not required for this" — the check needs to
  // go looking for a target that's actually worth protecting.
  private static readonly SENSITIVE_ENDPOINT_PATTERN =
    /login|signin|sign-in|auth|otp|verify|token|password|reset|forgot|signup|sign-up|register|search/i;

  // Testing every sensitive-looking endpoint individually, not just the first match — a real
  // app can easily have several worth checking independently (login, OTP verify, password
  // reset, search all being separately exploitable). Capped so one session doesn't turn into
  // an unbounded number of 20-request bursts.
  private static readonly MAX_SENSITIVE_ENDPOINTS_TO_TEST = 5;

  private async probeOneRateLimitTarget(
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

  private async testRateLimit(
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
      ...new Set(discovered.filter((e) => ApiExecutor.SENSITIVE_ENDPOINT_PATTERN.test(e))),
    ].slice(0, ApiExecutor.MAX_SENSITIVE_ENDPOINTS_TO_TEST);

    if (sensitiveDiscovered.length > 0) {
      ctx.onLog(
        `[RateLimit] Found ${sensitiveDiscovered.length} real, sensitive discovered endpoint(s) to test: ${sensitiveDiscovered.join(', ')}`,
      );
      let count = 0;
      for (const entry of sensitiveDiscovered) {
        const [method, path] = entry.split(' ');
        count += await this.probeOneRateLimitTarget(
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

    return this.probeOneRateLimitTarget(baseUrl, headers, ctx, 'GET', probePath, false);
  }

  private async testPrivilegeEscalation(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
    flowClass: string,
  ): Promise<number> {
    // Prefer real discovered endpoints that look admin/role-flavored; a hardcoded
    // /api/admin against an app whose API lives elsewhere never matches anything.
    const fallbackPaths = ['/api/admin', '/api/users', '/api/settings'];
    const discovered = this.resolveEndpointPaths(ctx, []).filter((p) =>
      /admin|settings|role|permission|user/i.test(p),
    );
    const paths = (discovered.length > 0 ? discovered : fallbackPaths).slice(0, 5);

    // Vertical-privilege ("can a non-admin reach admin endpoints?") is only meaningful
    // when the session under test is NOT itself an admin-level account — otherwise
    // "admin can reach admin endpoints" isn't a finding, it's the account working as
    // designed. Without a second, genuinely low-privileged credential set, downgrade
    // rather than falsely flag a vulnerability.
    const usernameLooksPrivileged = /admin|root|super/i.test(ctx.config.credentials?.username ?? '');

    let count = 0;

    for (const path of paths) {
      // Dedup key MUST include flowClass — horizontal-privilege and vertical-privilege
      // probe the same paths but are distinct checks; sharing a bare-path dedup set
      // silently skipped the second flow class entirely once the first had run.
      const dedupKey = `${flowClass}-${path}`;
      if (this.reportedPrivilegePaths.has(dedupKey)) continue;
      this.reportedPrivilegePaths.add(dedupKey);

      try {
        const { status, isJson } = await probe(baseUrl, { method: 'GET', path }, headers);

        if (status === 200 && isJson) {
          if (flowClass === 'vertical-privilege' && usernameLooksPrivileged) {
            ctx.onLog(
              `[Privilege] ${path} → 200 for account "${ctx.config.credentials?.username}" — this ` +
              `account already looks admin-level, so access here doesn't demonstrate privilege ` +
              `escalation; re-test with a genuinely low-privileged account for a conclusive result`,
            );
            continue;
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
            evidence: [],
            reproRate: '1/1',
            automationCandidate: true,
          });
          count++;
        } else if (status === 200 && !isJson) {
          ctx.onLog(`[Privilege] ${path} → 200 but HTML (SPA catch-all) — not a real API endpoint, skipping`);
        } else if (status === 403 || status === 401) {
          ctx.onLog(`[Privilege] ${path} → ${status} — correctly protected`);
        }
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  private async testMassAssignment(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const sensitiveFields = [
      { field: 'role', value: 'admin' },
      { field: 'isAdmin', value: true },
      { field: 'verified', value: true },
      { field: 'credits', value: 999999 },
      { field: 'balance', value: 999999 },
    ];

    // Real discovered traffic during navigation is GET-only (no forms were submitted),
    // so there's rarely a captured write endpoint to target directly. Derive plausible
    // update targets from discovered collection paths (";/me" and the bare collection)
    // instead of assuming a hardcoded /api/users/me that only matches a narrow class
    // of REST APIs.
    const collectionPaths = this.resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
    const targets = new Set<string>(['/api/users/me']);
    for (const p of collectionPaths) {
      const base = p.replace(/\/$/, '');
      targets.add(`${base}/me`);
      targets.add(base);
    }

    let count = 0;
    for (const path of targets) {
      for (const method of ['PATCH', 'PUT', 'POST']) {
        for (const sf of sensitiveFields) {
          try {
            const { status, body } = await probe(
              baseUrl,
              { method, path, body: { [sf.field]: sf.value } },
              headers,
            );

            if (status === 200 && reflectsField(body, sf.field, sf.value)) {
              ctx.onFinding({
                severity: 'high',
                area: 'Security-MassAssignment',
                title: `Mass assignment accepted sensitive field: "${sf.field}" via ${method} ${path}`,
                steps: [`${method} ${path} with body: {"${sf.field}": ${JSON.stringify(sf.value)}}`],
                expected: 'Sensitive field ignored or rejected with 400',
                actual: `HTTP 200 and field value "${sf.value}" appears in response body`,
                evidence: [],
                reproRate: '1/1',
                automationCandidate: true,
              });
              count++;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (count === 0) {
      ctx.onLog(
        `[MassAssignment] No sensitive field accepted across ${targets.size} target(s) — ` +
        'note: without a captured write endpoint, this checks plausible update targets rather than ' +
        'a confirmed one; a clean result here is weaker evidence than a clean result on a known write path',
      );
    }
    return count;
  }

  /**
   * HTTP-level reflected-XSS probe: send common script payloads both as query params
   * (search/filter-style reflection) and as write-request field values, then check
   * whether the raw, unescaped payload survives in the response body. This catches
   * "input echoed back verbatim" — a real and common class of reflected XSS — but
   * cannot detect DOM-based/stored XSS that only manifests when a browser actually
   * renders the page, since this never touches a real DOM.
   */
  private async testXssProbe(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const payloads = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "';alert(1);//"];
    const targets = this.resolveEndpointPaths(ctx, ['/api/search', '/api/users']).slice(0, 3);
    let count = 0;

    for (const basePath of targets) {
      for (const payload of payloads) {
        try {
          const path = `${basePath}?search=${encodeURIComponent(payload)}&q=${encodeURIComponent(payload)}`;
          const { status, body } = await probe(baseUrl, { method: 'GET', path }, headers);
          if (status === 200 && body.includes(payload)) {
            ctx.onFinding({
              severity: 'high',
              area: 'Security-XSS',
              title: `Unescaped payload reflected in query response: ${basePath}`,
              steps: [`GET ${basePath}?search=${payload}`],
              expected: 'User input reflected in responses should be HTML/JSON-escaped',
              actual: `Raw payload "${payload}" appears unescaped in the response body`,
              evidence: [],
              reproRate: '1/1',
              automationCandidate: true,
            });
            count++;
          }
        } catch {
          /* ignore */
        }

        try {
          const { status, body } = await probe(
            baseUrl,
            {
              method: 'POST',
              path: basePath,
              body: { name: payload, title: payload, comment: payload, content: payload },
            },
            headers,
          );
          if (status === 200 && body.includes(payload)) {
            ctx.onFinding({
              severity: 'high',
              area: 'Security-XSS',
              title: `Unescaped payload accepted and reflected: POST ${basePath}`,
              steps: [`POST ${basePath} with a text field set to: ${payload}`],
              expected: 'Free-text fields should be sanitized or escaped before being echoed back',
              actual: `Raw payload "${payload}" appears unescaped in the response body`,
              evidence: [],
              reproRate: '1/1',
              automationCandidate: true,
            });
            count++;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (count === 0) {
      ctx.onLog(
        `[XSS] No unescaped payload reflection detected across ${targets.length} target(s) — ` +
        'note: this is an HTTP-level check only and cannot detect stored/DOM-based XSS that requires ' +
        'a real browser render',
      );
    }
    return count;
  }

  private async testSpikeLoad(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const SPIKE_COUNT = 50;
    ctx.onLog(`[SpikeLoad] Firing ${SPIKE_COUNT} concurrent requests`);

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: SPIKE_COUNT }, () =>
        probe(baseUrl, { method: 'GET', path: '/' }, headers).catch(() => ({
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
      title: `Spike load (${SPIKE_COUNT} concurrent): ${successRate.toFixed(0)}% success`,
      steps: [`Fire ${SPIKE_COUNT} concurrent GET / requests`],
      expected: '>95% success rate under spike load',
      actual: `Success: ${results.length - errors.length}/${SPIKE_COUNT}, Errors: ${errors.length}, Rate-limited: ${rateLimited.length}, Time: ${elapsed}ms`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });

    return errors.length > 0 ? 1 : 0;
  }

  private async testNPlusOne(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    // Detect N+1 by counting API calls made after loading a list page
    const listPaths = ['/api/users', '/api/items', '/api/products', '/api/orders'];
    let count = 0;

    for (const listPath of listPaths) {
      try {
        const { status, body } = await probe(baseUrl, { method: 'GET', path: listPath }, headers);
        if (status !== 200) continue;

        let items: unknown[];
        try {
          const parsed = JSON.parse(body);
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
          evidence: [],
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

  private async testSchemaDrift(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const endpoints = [
      { path: '/api/users/me', requiredFields: ['id', 'email'] },
      { path: '/api/health', requiredFields: ['status'] },
      { path: '/api', requiredFields: [] },
    ];

    let count = 0;
    for (const ep of endpoints) {
      try {
        const { status, body } = await probe(baseUrl, { method: 'GET', path: ep.path }, headers);
        if (status !== 200) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          continue;
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
          count++;
        } else if (ep.requiredFields.length > 0) {
          ctx.onLog(`[SchemaDrift] ${ep.path} — all expected fields present`);
        }
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  private async testLoadTime(baseUrl: string, ctx: ExecutorContext): Promise<number> {
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
          evidence: [],
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
}
