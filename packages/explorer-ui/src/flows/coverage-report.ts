import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { getVisitedPaths, clearVisitTracking } from './page-visit-tracker.js';

// Runs last (report phase) so it can answer, with real numbers, the question this agent kept
// getting asked without a good answer: "were the tabs/sidebar/routes actually explored, and
// how would I check?" — turns scattered per-flow log lines into one explicit ratio plus a
// named list of what was skipped.
export async function runCoverageReport(
  _page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const visited = new Set(getVisitedPaths(ctx.sessionId));
  ctx.visitedRoutes = [...visited];

  const discovered = ctx.discoveredRoutes ?? [];
  if (discovered.length === 0) {
    ctx.onLog(
      `[Coverage] ${visited.size} distinct route(s) visited this session (no landing-page route ` +
        'list from recon to compare against, so no coverage ratio)',
    );
    clearVisitTracking(ctx.sessionId);
    return;
  }

  const notVisited = discovered.filter((r) => !visited.has(r));
  const visitedCount = discovered.length - notVisited.length;
  ctx.onLog(
    `[Coverage] ${visitedCount}/${discovered.length} discovered route(s) explored` +
      (notVisited.length > 0 ? ` — not visited: ${notVisited.slice(0, 10).join(', ')}` : ''),
  );

  clearVisitTracking(ctx.sessionId);
}
