import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export async function runToastStackingCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Toasts] Triggering rapid actions to check toast/notification stacking behaviour');

  const actionable = page.locator('button:visible, [type="submit"]:visible');
  const count = await actionable.count().catch(() => 0);
  if (count === 0) {
    ctx.onLog('[Toasts] No actionable buttons found');
    return;
  }

  const attempts = Math.min(count, 4);
  for (let i = 0; i < attempts; i++) {
    await actionable.nth(i).click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);

  const toastRects = await page
    .evaluate(() => {
      const toasts = Array.from(
        document.querySelectorAll(
          '[class*="toast"], [class*="snackbar"], [role="alert"], [role="status"], [class*="notification"]',
        ),
      );
      const rects: Rect[] = [];
      for (const el of toasts) {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        rects.push({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
      }
      return rects;
    })
    .catch(() => [] as Rect[]);

  if (toastRects.length < 2) {
    ctx.onLog(`[Toasts] ${toastRects.length} toast(s) visible after rapid actions — nothing to check for stacking`);
    return;
  }

  let overlapping = false;
  outer: for (let i = 0; i < toastRects.length; i++) {
    for (let j = i + 1; j < toastRects.length; j++) {
      const a = toastRects[i];
      const b = toastRects[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        overlapping = true;
        break outer;
      }
    }
  }

  if (!overlapping) {
    ctx.onLog(`[Toasts] ${toastRects.length} notifications visible, stacked without overlap`);
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'toast-stacking.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'low',
    area: 'UI-Toasts',
    title: `${toastRects.length} notifications overlap when triggered in quick succession`,
    steps: ['Trigger several toast/notification-producing actions in quick succession', 'Observe the notifications'],
    expected: 'Multiple simultaneous notifications stack or queue without overlapping',
    actual: `${toastRects.length} notification elements visible with overlapping bounding boxes`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: page.url(),
  });
}
