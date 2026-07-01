import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type {
  BaseExecutor,
  ExecutorContext,
  ExecutorResult,
  ExplorationArea,
  FlowTask,
} from '@qa/shared';

async function withPage(ctx: ExecutorContext, fn: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runSlowNetwork(
  page: Page,
  ctx: ExecutorContext,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
    latency: 400,
  });

  const start = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const elapsed = Date.now() - start;

  if (elapsed > 10000) {
    ctx.onFinding({
      severity: 'info',
      area: 'Chaos-Network',
      title: `Slow network (3G): page load took ${(elapsed / 1000).toFixed(1)}s`,
      steps: ['Emulate 3G network', 'Reload page'],
      expected: 'Acceptable loading UX under slow network',
      actual: `Load completed in ${elapsed}ms — verify loading indicators`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}

export async function runOfflineMidRequest(
  page: Page,
  ctx: ExecutorContext,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const submit = page.locator('form button[type="submit"], button:has-text("Submit")').first();

  if ((await submit.count()) === 0) {
    ctx.onLog('[Chaos] No submit button for offline test');
    return;
  }

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    downloadThroughput: 0,
    uploadThroughput: 0,
    latency: 0,
  });

  await submit.click().catch(() => {});
  await page.waitForTimeout(1000);

  const errorVisible = await page
    .locator(':text("offline"), :text("network"), :text("connection"), [role="alert"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (!errorVisible) {
    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'offline-no-error.png');
    await page.screenshot({ path: shot }).catch(() => {});

    ctx.onFinding({
      severity: 'medium',
      area: 'Chaos-Network',
      title: 'No user-visible error when offline during submit',
      steps: ['Go offline', 'Submit form'],
      expected: 'Clear offline/network error message',
      actual: 'No visible error indicator detected',
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}

export async function runOfflineRecovery(
  page: Page,
  ctx: ExecutorContext,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    downloadThroughput: 0,
    uploadThroughput: 0,
    latency: 0,
  });
  await page.waitForTimeout(1000);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  ctx.onFinding({
    severity: 'info',
    area: 'Chaos-Network',
    title: 'Offline-to-online recovery completed',
    steps: ['Go offline', 'Wait 1s', 'Go online', 'Reload'],
    expected: 'App recovers gracefully after network restore',
    actual: `Page loaded at ${page.url()} — verify pending actions retried correctly`,
    evidence: [],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

export async function runDoubleSubmit(
  page: Page,
  ctx: ExecutorContext,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (50 * 1024) / 8,
    uploadThroughput: (50 * 1024) / 8,
    latency: 2000,
  });

  let postCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST') postCount++;
  });

  const submit = page.locator('form button[type="submit"], button:has-text("Submit")').first();
  if ((await submit.count()) > 0) {
    await submit.click();
    await submit.click().catch(() => {});
    await page.waitForTimeout(5000);

    if (postCount > 1) {
      ctx.onFinding({
        severity: 'high',
        area: 'Chaos-DoubleSubmit',
        title: 'Duplicate POST on slow network + double click',
        steps: ['Throttle network', 'Click submit twice'],
        expected: 'Debounced or idempotent submit',
        actual: `${postCount} POST requests sent`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
  }
}

// C4 — Flaky network: 50% request failure rate
async function runFlakyNetwork(page: Page, ctx: ExecutorContext): Promise<void> {
  let interceptCount = 0;
  let failedCount = 0;

  await page.route('**/*', async (route) => {
    interceptCount++;
    if (interceptCount % 2 === 0) {
      failedCount++;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const bodyText = await page.locator('body').textContent().catch(() => '');
  const hasErrorHandling =
    bodyText?.toLowerCase().includes('retry') ||
    bodyText?.toLowerCase().includes('try again') ||
    bodyText?.toLowerCase().includes('error') ||
    bodyText?.toLowerCase().includes('failed');

  await page.unroute('**/*');

  if (!hasErrorHandling) {
    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'flaky-network.png');
    await page.screenshot({ path: shot }).catch(() => {});

    ctx.onFinding({
      severity: 'medium',
      area: 'Chaos-Network',
      title: 'No retry/error UI under 50% flaky network conditions',
      steps: ['Intercept 50% of requests and abort them', 'Reload page', 'Observe error handling'],
      expected: 'App shows retry prompt or graceful degradation message',
      actual: `${failedCount}/${interceptCount} requests aborted with no visible error recovery UI`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog(`[FlakyNetwork] Error handling present (${failedCount}/${interceptCount} requests failed)`);
  }
}

// C5 — Request timeout + retry
async function runTimeoutRetry(page: Page, ctx: ExecutorContext): Promise<void> {
  let retryDetected = false;
  let requestCount = 0;
  const seenUrls = new Map<string, number>();

  page.on('request', (req) => {
    const url = req.url();
    const count = (seenUrls.get(url) ?? 0) + 1;
    seenUrls.set(url, count);
    requestCount++;
    if (count > 1) retryDetected = true;
  });

  // Delay all API calls to simulate timeout conditions
  await page.route('**/api/**', async (route) => {
    await new Promise((res) => setTimeout(res, 5000));
    await route.continue();
  });

  const start = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const elapsed = Date.now() - start;

  await page.unroute('**/api/**');

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'timeout-retry.png');
  await page.screenshot({ path: shot }).catch(() => {});

  ctx.onFinding({
    severity: 'info',
    area: 'Chaos-Timeout',
    title: `API timeout behaviour: ${retryDetected ? 'retry detected' : 'no retry observed'}`,
    steps: ['Delay all /api/** requests by 5s', 'Reload page', 'Monitor for retry requests'],
    expected: 'App retries failed API calls or shows timeout error with retry option',
    actual: `Total requests: ${requestCount}, retries: ${retryDetected ? 'yes' : 'none detected'}, elapsed: ${(elapsed / 1000).toFixed(1)}s`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

// C6 — WebSocket disconnect
async function runWebsocketDisconnect(page: Page, ctx: ExecutorContext): Promise<void> {
  const wsConnections: string[] = [];

  page.on('websocket', (ws) => {
    wsConnections.push(ws.url());
    ctx.onLog(`[WS] Connected: ${ws.url()}`);

    ws.on('close', () => {
      ctx.onLog(`[WS] Closed: ${ws.url()}`);
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (wsConnections.length === 0) {
    ctx.onLog('[WS] No WebSocket connections detected on this page');
    return;
  }

  // Simulate disconnect by going offline then online
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    downloadThroughput: 0,
    uploadThroughput: 0,
    latency: 0,
  });
  await page.waitForTimeout(2000);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await page.waitForTimeout(3000);

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'ws-disconnect.png');
  await page.screenshot({ path: shot }).catch(() => {});

  const bodyText = await page.locator('body').textContent().catch(() => '');
  const hasReconnectUI =
    bodyText?.toLowerCase().includes('reconnect') ||
    bodyText?.toLowerCase().includes('connecting') ||
    bodyText?.toLowerCase().includes('connection lost');

  ctx.onFinding({
    severity: hasReconnectUI ? 'info' : 'medium',
    area: 'Chaos-WebSocket',
    title: hasReconnectUI
      ? 'WebSocket reconnection UI detected'
      : 'No reconnection UI after WebSocket disconnect',
    steps: [
      `Detected ${wsConnections.length} WebSocket connection(s)`,
      'Simulate network offline for 2s then restore',
      'Check for reconnection behaviour',
    ],
    expected: 'App shows reconnecting state and automatically reconnects',
    actual: hasReconnectUI
      ? 'Reconnection UI visible — verify data resync'
      : 'No visible reconnection handling after 3s',
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

const CHAOS_HANDLERS: Record<string, (page: Page, ctx: ExecutorContext) => Promise<void>> = {
  'slow-network': runSlowNetwork,
  'offline-mid-request': runOfflineMidRequest,
  'offline-recovery': runOfflineRecovery,
  'double-submit': runDoubleSubmit,
  'flaky-network': runFlakyNetwork,
  'timeout-retry': runTimeoutRetry,
  'websocket-disconnect': runWebsocketDisconnect,
  'back-during-post': async (_page, ctx) => {
    ctx.onLog('[Chaos] back-during-post handled by UI executor');
  },
  'refresh-during-request': async (_page, ctx) => {
    ctx.onLog('[Chaos] refresh-during-request handled by UI executor');
  },
};

export class ChaosExecutor implements BaseExecutor {
  name = 'chaos';
  areas: ExplorationArea[] = ['chaos'];

  async execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult> {
    let findingsCount = 0;
    const wrappedCtx: ExecutorContext = {
      ...ctx,
      onFinding: (f) => {
        findingsCount++;
        ctx.onFinding(f);
      },
    };

    ctx.onLog(`[Chaos] Starting: ${task.title}`);

    const handler = CHAOS_HANDLERS[task.flowClass];
    if (!handler) {
      ctx.onLog(`[Chaos] Unknown flow: ${task.flowClass}`);
      return { taskId: task.id, success: true, findingsCount: 0 };
    }

    try {
      await withPage(wrappedCtx, (page) => handler(page, wrappedCtx));
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
