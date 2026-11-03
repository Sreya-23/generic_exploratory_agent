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
// Only the APPLICATION's own requests are failed and judged. Aborting third-party analytics,
// fonts or ad beacons and then demanding a "retry" message on screen was a false positive: the
// page legitimately looks the same without them. A finding is raised only when failing the
// app's own requests visibly breaks the page (content or controls go missing) AND nothing tells
// the user what happened.
async function runFlakyNetwork(page: Page, ctx: ExecutorContext): Promise<void> {
  let site = '';
  try {
    site = new URL(page.url()).hostname.split('.').slice(-2).join('.');
  } catch {
    /* keep empty — every request then counts as first-party */
  }
  const measure = () =>
    page
      .evaluate(() => ({
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
        controls: document.querySelectorAll('a[href], button, input, select').length,
      }))
      .catch(() => ({ text: 0, controls: 0 }));
  // Let the page finish its own data loading first, so the baseline includes it.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const baseline = await measure();

  let interceptCount = 0;
  let failedCount = 0;
  const failedUrls: string[] = [];

  await page.route('**/*', async (route) => {
    const req = route.request();
    let host = '';
    try {
      host = new URL(req.url()).hostname;
    } catch {
      /* ignore */
    }
    const firstParty = !site || host.endsWith(site);
    // Only the app's own DATA calls (XHR/fetch) are failed. Failing the document tests "site
    // down", and failing the JS/CSS bundle tests "site half-deployed" — neither is something an
    // app is expected to show a friendly retry message for. A data call failing is.
    const isDataCall = req.resourceType() === 'xhr' || req.resourceType() === 'fetch';
    if (!firstParty || !isDataCall) {
      await route.continue();
      return;
    }
    interceptCount++;
    if (interceptCount % 2 === 0) {
      failedCount++;
      if (failedUrls.length < 5) failedUrls.push(req.url().replace(/^https?:\/\//, '').slice(0, 80));
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const after = await measure();

  const bodyText = (await page.locator('body').textContent().catch(() => ''))?.toLowerCase() ?? '';
  const hasErrorHandling = /retry|try again|error|failed|offline|connection|something went wrong|reload/.test(bodyText);

  await page.unroute('**/*');

  if (failedCount === 0) {
    ctx.onLog('[FlakyNetwork] The page made no first-party data (XHR/fetch) requests on load — nothing to fail');
    return;
  }
  const textLoss = baseline.text > 0 ? 1 - after.text / baseline.text : 0;
  const controlLoss = baseline.controls > 0 ? 1 - after.controls / baseline.controls : 0;
  const broken = textLoss > 0.3 || controlLoss > 0.3;

  if (!broken) {
    ctx.onLog(
      `[FlakyNetwork] Page stayed usable with ${failedCount}/${interceptCount} first-party requests failed ` +
        `(text ${Math.round(textLoss * 100)}% / controls ${Math.round(controlLoss * 100)}% lost) — resilient, not reported`,
    );
    return;
  }
  if (hasErrorHandling) {
    ctx.onLog(`[FlakyNetwork] Page degraded but shows an error/retry message (${failedCount}/${interceptCount} failed)`);
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'flaky-network.png');
  await page.screenshot({ path: shot }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'Chaos-Network',
    title: 'Page silently breaks when some of its own requests fail',
    steps: [
      'Fail every second XHR/fetch request the page makes to its own servers (DevTools → Network request blocking, or a proxy)',
      'Reload the page',
      'Compare with a normal load',
    ],
    expected: 'App retries, or shows an error/retry message when content fails to load',
    actual:
      `${failedCount}/${interceptCount} first-party requests failed (e.g. ${failedUrls.join(', ')}); ` +
      `the page lost ${Math.round(textLoss * 100)}% of its text and ${Math.round(controlLoss * 100)}% of its controls with no message to the user`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
    confidence: 'verified',
    confidenceReason: 'Measured page content before and after failing only the site\'s own requests, and checked for any error/retry wording.',
  });
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

// CPU throttling — a distinct axis from slow-network above: simulates a low-end mobile CPU
// rather than a slow connection, catching pages that load fine but never finish hydrating
// (or take unacceptably long) on weak hardware.
async function runCpuThrottle(page: Page, ctx: ExecutorContext): Promise<void> {
  const targetUrl = page.url();
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  } catch (err) {
    ctx.onLog(`[CPUThrottle] CDP not available on this engine (${(err as Error).message.slice(0, 100)}) — skipping, Chromium-only check`);
    return;
  }

  try {
    const start = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const deadline = Date.now() + 15000;
    let hasContent = false;
    while (Date.now() < deadline) {
      hasContent = await page.evaluate(() => (document.body?.innerText ?? '').trim().length > 100).catch(() => false);
      if (hasContent) break;
      await page.waitForTimeout(300);
    }
    const elapsed = Date.now() - start;

    if (!hasContent) {
      ctx.onFinding({
        severity: 'medium',
        area: 'Perf-CPUThrottle',
        title: 'Page fails to render meaningful content under CPU throttling (6x slowdown)',
        steps: [`Open ${targetUrl} with CPU throttled 6x (simulating a low-end mobile device)`],
        expected: 'Page still renders usable content within a reasonable time on slower hardware',
        actual: `No meaningful content rendered within 15s of throttled load (elapsed ${elapsed}ms)`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: targetUrl,
      });
    } else if (elapsed > 8000) {
      ctx.onFinding({
        severity: 'low',
        area: 'Perf-CPUThrottle',
        title: `Slow initial render under CPU throttling (${(elapsed / 1000).toFixed(1)}s)`,
        steps: [`Open ${targetUrl} with CPU throttled 6x`],
        expected: 'Content renders reasonably quickly even on low-end hardware',
        actual: `Took ${(elapsed / 1000).toFixed(1)}s to render meaningful content under 6x CPU throttling`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: targetUrl,
      });
    } else {
      ctx.onLog(`[CPUThrottle] Rendered in ${elapsed}ms under 6x throttling — acceptable`);
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  }
}

const CHAOS_HANDLERS: Record<string, (page: Page, ctx: ExecutorContext) => Promise<void>> = {
  'slow-network': runSlowNetwork,
  'offline-mid-request': runOfflineMidRequest,
  'offline-recovery': runOfflineRecovery,
  'double-submit': runDoubleSubmit,
  'flaky-network': runFlakyNetwork,
  'timeout-retry': runTimeoutRetry,
  'websocket-disconnect': runWebsocketDisconnect,
  'cpu-throttle': runCpuThrottle,
  // 'back-during-post'/'refresh-during-request'/'cancel-during-loading'/
  // 'navigate-away-during-loading' are scheduled under this area but routed to UiExecutor via
  // FLOW_CLASS_EXECUTOR_OVERRIDE in run-session.ts — no entry needed (or reachable) here.
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
