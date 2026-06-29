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
  probe: ApiProbe,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(probe.path, baseUrl).toString();
  const res = await fetch(url, {
    method: probe.method,
    headers: { ...headers, ...probe.headers },
    body: probe.body ? JSON.stringify(probe.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, body: body.slice(0, 500) };
}

const COMMON_PATHS = ['/api', '/api/v1', '/api/health', '/health', '/api/users', '/api/status'];

export class ApiExecutor implements BaseExecutor {
  name = 'api';
  areas: ExplorationArea[] = ['api', 'security', 'performance'];

  async execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult> {
    let findingsCount = 0;
    const baseUrl = ctx.config.targetUrl;
    const headers = buildHeaders(ctx);

    ctx.onLog(`[API] Starting: ${task.title}`);

    try {
      if (task.flowClass === 'crud' || task.flowClass === 'boundary') {
        findingsCount += await this.probeCommonEndpoints(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'auth-matrix' || task.flowClass === 'auth-bypass') {
        findingsCount += await this.testAuthMatrix(baseUrl, ctx);
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

  private async probeCommonEndpoints(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    let count = 0;
    for (const path of COMMON_PATHS) {
      try {
        const { status } = await probe(baseUrl, { method: 'GET', path }, headers);
        ctx.onLog(`[API] GET ${path} → ${status}`);

        if (status === 200) {
          ctx.onFinding({
            severity: 'info',
            area: 'API-Discovery',
            title: `Discovered endpoint: GET ${path}`,
            steps: [`GET ${path}`],
            expected: 'Endpoint exists',
            actual: `HTTP 200`,
            evidence: [],
            reproRate: '1/1',
            automationCandidate: true,
          });
          count++;
        }
      } catch {
        /* endpoint may not exist */
      }
    }
    return count;
  }

  private async testAuthMatrix(baseUrl: string, ctx: ExecutorContext): Promise<number> {
    let count = 0;
    for (const path of COMMON_PATHS.slice(0, 3)) {
      try {
        const { status } = await probe(baseUrl, { method: 'GET', path }, {});
        if (status === 200) {
          ctx.onFinding({
            severity: 'high',
            area: 'API-Auth',
            title: `Unauthenticated access to ${path}`,
            steps: [`GET ${path} without auth headers`],
            expected: '401 or 403',
            actual: `HTTP ${status} without credentials`,
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
        const { status } = await probe(
          baseUrl,
          { method: 'GET', path: `/api/users/${id}` },
          headers,
        );
        if (status === 200) {
          ctx.onFinding({
            severity: 'info',
            area: 'API-Security',
            title: `User resource accessible: /api/users/${id}`,
            steps: [`GET /api/users/${id}`],
            expected: 'Proper authorization check',
            actual: `HTTP 200 — verify caller is authorized for this resource`,
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

  private async testRateLimit(
    baseUrl: string,
    headers: Record<string, string>,
    ctx: ExecutorContext,
  ): Promise<number> {
    const requests = Array.from({ length: 20 }, () =>
      probe(baseUrl, { method: 'GET', path: '/api/health' }, headers).catch(() => ({
        status: 0,
        body: '',
      })),
    );
    const results = await Promise.all(requests);
    const rateLimited = results.some((r) => r.status === 429);

    if (!rateLimited) {
      ctx.onFinding({
        severity: 'low',
        area: 'API-RateLimit',
        title: 'No rate limiting detected after 20 rapid requests',
        steps: ['Send 20 rapid GET /api/health'],
        expected: '429 after burst threshold',
        actual: 'No 429 responses observed',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      return 1;
    }
    return 0;
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
