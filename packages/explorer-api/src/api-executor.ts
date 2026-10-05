import type {
  BaseExecutor,
  ExecutorContext,
  ExecutorResult,
  ExplorationArea,
  FlowTask,
} from '@qa/shared';
import { buildHeaders } from './probe-helpers.js';
import { probeCommonEndpoints } from './checks/discovery.js';
import { testAuthMatrix } from './checks/auth.js';
import { testPagination } from './checks/boundary.js';
import { testIdor } from './checks/idor.js';
import { testRateLimit } from './checks/rate-limit.js';
import { testPrivilegeEscalation } from './checks/privilege.js';
import { testMassAssignment, testXssProbe } from './checks/injection.js';
import { testSpikeLoad, testNPlusOne, testLoadTime } from './checks/performance.js';
import { testSchemaDrift } from './checks/regression.js';

export class ApiExecutor implements BaseExecutor {
  name = 'api';
  areas: ExplorationArea[] = ['api', 'security', 'performance'];

  // Track which auth/privilege findings have already been reported to prevent duplicates
  // (auth-matrix and auth-bypass both run testAuthMatrix; horizontal/vertical-privilege
  // both run testPrivilegeEscalation) — shared across calls for the lifetime of this executor.
  private reportedAuthPaths = new Set<string>();
  private reportedPrivilegePaths = new Set<string>();

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
        findingsCount += await probeCommonEndpoints(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'auth-matrix' || task.flowClass === 'auth-bypass') {
        findingsCount += await testAuthMatrix(baseUrl, ctx, headers, this.reportedAuthPaths);
      }

      if (task.flowClass === 'pagination') {
        findingsCount += await testPagination(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'idor-probe') {
        findingsCount += await testIdor(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'rate-limit') {
        findingsCount += await testRateLimit(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'load-time') {
        findingsCount += await testLoadTime(baseUrl, ctx);
      }

      if (task.flowClass === 'horizontal-privilege' || task.flowClass === 'vertical-privilege') {
        findingsCount += await testPrivilegeEscalation(
          baseUrl,
          headers,
          ctx,
          task.flowClass,
          this.reportedPrivilegePaths,
        );
      }

      if (task.flowClass === 'mass-assignment') {
        findingsCount += await testMassAssignment(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'xss-probe') {
        findingsCount += await testXssProbe(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'spike-load') {
        findingsCount += await testSpikeLoad(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'n-plus-one') {
        findingsCount += await testNPlusOne(baseUrl, headers, ctx);
      }

      if (task.flowClass === 'schema-drift') {
        findingsCount += await testSchemaDrift(baseUrl, headers, ctx);
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
}
