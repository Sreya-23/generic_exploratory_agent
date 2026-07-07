import type {
  BaseExecutor,
  ExecutorContext,
  ExecutorResult,
  ExplorationArea,
  FlowTask,
} from '@qa/shared';

interface ApiProbe {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function buildHeaders(ctx: ExecutorContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const creds = ctx.config.credentials;
  if (creds?.type === 'bearer' && creds.bearerToken) {
    headers.Authorization = `Bearer ${creds.bearerToken}`;
  } else if (creds?.type === 'api-key' && creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }
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
    let count = 0;

    for (const query of edgeCases) {
      try {
        const { status, body } = await probe(
          baseUrl,
          { method: 'GET', path: `/api/users${query}` },
          headers,
        );
        if (status >= 500) {
          ctx.onFinding({
            severity: 'medium',
            area: 'API-Boundary',
            title: `Server error on pagination edge case: ${query}`,
            steps: [`GET /api/users${query}`],
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
    return count;
  }

  private async testIdor(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const ids = ['1', '2', '999', '../admin', '0'];
    let count = 0;

    for (const id of ids) {
      try {
        const { status, isJson } = await probe(
          baseUrl,
          { method: 'GET', path: `/api/users/${id}` },
          headers,
        );
        if (status === 200 && isJson) {
          // Only flag if JSON — HTML means SPA, not an actual user data endpoint
          ctx.onFinding({
            severity: 'info',
            area: 'API-Security',
            title: `User resource returns JSON: /api/users/${id}`,
            steps: [`GET /api/users/${id}`],
            expected: 'Proper authorization check on user data',
            actual: `HTTP 200 with JSON — verify caller is authorized for this resource`,
            evidence: [],
            reproRate: '1/1',
            automationCandidate: true,
          });
          count++;
        } else if (status === 200 && !isJson) {
          ctx.onLog(`[IDOR] /api/users/${id} → 200 HTML (SPA catch-all) — not a real endpoint`);
        }
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  private async testRateLimit(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    // Discover a responsive endpoint on the TARGET site to probe for rate limiting.
    // Prefer an API-like path; fall back to the root. Never use /api/health which
    // is the agent's own backend, not the site under test.
    // Find a real JSON API path to rate-limit test; fall back to root if none found
    const candidatePaths = ['/api/v1', '/api', '/api/status', '/api/health', '/'];
    let probePath = '/';

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
    // If no JSON endpoint found, always use root for rate-limit baseline
    if (probePath === '/' ) {
      ctx.onLog('[RateLimit] No JSON API endpoint found — testing rate limit on root URL');
    }

    ctx.onLog(`[RateLimit] Sending 20 rapid GET ${probePath} to ${baseUrl}`);

    const requests = Array.from({ length: 20 }, () =>
      probe(baseUrl, { method: 'GET', path: probePath }, headers).catch(() => ({
        status: 0,
        body: '',
      })),
    );
    const results = await Promise.all(requests);
    const rateLimited = results.some((r) => r.status === 429);
    const statuses = [...new Set(results.map((r) => r.status))].join(', ');

    ctx.onLog(`[RateLimit] Results: ${results.length} requests, statuses seen: ${statuses}`);

    if (!rateLimited) {
      ctx.onFinding({
        severity: 'low',
        area: 'API-RateLimit',
        title: `No rate limiting detected after 20 rapid requests to ${probePath}`,
        steps: [`Send 20 concurrent GET ${probePath} to ${baseUrl}`],
        expected: 'HTTP 429 after burst threshold',
        actual: `No 429 observed. Statuses: ${statuses}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      return 1;
    }

    ctx.onLog(`[RateLimit] Rate limiting active on ${probePath} — OK`);
    return 0;
  }

  private async testPrivilegeEscalation(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
    flowClass: string,
  ): Promise<number> {
    const adminPaths = ['/api/admin', '/api/users', '/api/users/1', '/admin', '/api/settings'];
    let count = 0;

    for (const path of adminPaths) {
      // Deduplicate across horizontal-privilege and vertical-privilege
      const dedupKey = `${flowClass}-${path}`;
      if (this.reportedPrivilegePaths.has(path)) continue;

      try {
        const { status, isJson } = await probe(baseUrl, { method: 'GET', path }, headers);

        if (status === 200 && isJson) {
          // Only flag if the response is actually JSON — HTML means SPA catch-all
          this.reportedPrivilegePaths.add(path);
          const severity = flowClass === 'vertical-privilege' ? 'high' : 'medium';
          ctx.onFinding({
            severity,
            area: 'Security-Privilege',
            title: `Privileged JSON API endpoint accessible without proper auth: ${path}`,
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
        this.reportedPrivilegePaths.add(dedupKey);
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

    let count = 0;
    for (const sf of sensitiveFields) {
      try {
        const { status, body } = await probe(
          baseUrl,
          {
            method: 'POST',
            path: '/api/users/me',
            body: { [sf.field]: sf.value },
          },
          headers,
        );

        if (status === 200) {
          // Check if the field was accepted in the response
          if (body.includes(String(sf.value))) {
            ctx.onFinding({
              severity: 'high',
              area: 'Security-MassAssignment',
              title: `Mass assignment accepted sensitive field: "${sf.field}"`,
              steps: [`POST /api/users/me with body: {"${sf.field}": ${JSON.stringify(sf.value)}}`],
              expected: 'Sensitive field ignored or rejected with 400',
              actual: `HTTP 200 and field value "${sf.value}" appears in response body`,
              evidence: [],
              reproRate: '1/1',
              automationCandidate: true,
            });
            count++;
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (count === 0) {
      ctx.onLog('[MassAssignment] No sensitive field accepted in mass assignment probes');
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
