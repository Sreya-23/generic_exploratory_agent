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

const CHAOS_HANDLERS: Record<string, (page: Page, ctx: ExecutorContext) => Promise<void>> = {
  'slow-network': runSlowNetwork,
  'offline-mid-request': runOfflineMidRequest,
  'offline-recovery': runOfflineRecovery,
  'double-submit': runDoubleSubmit,
  'back-during-post': async (page, ctx) => {
    ctx.onLog('[Chaos] back-during-post handled by UI executor');
  },
  'refresh-during-request': async (page, ctx) => {
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
