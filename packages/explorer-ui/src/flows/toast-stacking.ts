import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const TOAST_SELECTOR = '[class*="toast"], [class*="snackbar"], [role="alert"], [role="status"], [class*="notification"]';

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

  if (toastRects.length === 0) {
    ctx.onLog('[Toasts] No toast/notification elements visible after rapid actions');
    return;
  }

  // ── Duplicate notifications — the SAME message appearing twice (a double-fire bug) ────────
  if (toastRects.length >= 2) {
    const texts = await page.evaluate((sel) =>
      Array.from(document.querySelectorAll(sel))
        .map((el) => (el as HTMLElement).innerText?.trim())
        .filter((t): t is string => Boolean(t) && t.length > 0),
      TOAST_SELECTOR,
    ).catch(() => [] as string[]);
    const seen = new Map<string, number>();
    for (const t of texts) seen.set(t, (seen.get(t) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    if (duplicated.length > 0) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Toasts',
        title: 'The same notification message appears more than once',
        steps: ['Trigger several notification-producing actions in quick succession', 'Compare the text of each visible notification'],
        expected: 'Each distinct event should produce one notification, not duplicates of the same message',
        actual: `Duplicate message(s) found: ${duplicated.map(([t, n]) => `"${t.slice(0, 60)}" ×${n}`).join('; ')}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
        confidence: 'heuristic',
        confidenceReason: 'Some UIs intentionally show the same generic message for multiple similar events — verify this reflects a real duplicate-fire bug before treating as confirmed.',
      });
    }
  }

  // ── Close notification — if a close/× control exists on a toast, it should dismiss it ─────
  const closeableToast = page.locator(TOAST_SELECTOR).filter({ has: page.locator('button, [role="button"]') }).first();
  if ((await closeableToast.count()) > 0) {
    const closeBtn = closeableToast.locator('button[aria-label*="close" i], button[aria-label*="dismiss" i], button:has-text("×"), button:has-text("✕")').first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(300);
      const stillVisible = await closeableToast.isVisible().catch(() => false);
      if (stillVisible) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Toasts',
          title: 'Notification close control does not dismiss it',
          steps: ['Trigger a notification with a visible close/× control', 'Click the close control'],
          expected: 'The notification should be dismissed',
          actual: 'The notification is still visible after clicking its close control',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
        });
      } else {
        ctx.onLog('[Toasts] Close control correctly dismisses the notification');
      }
    }
  } else {
    ctx.onLog('[Toasts] No notification with a distinct close control found — skipping close-button check');
  }

  // ── Notification after refresh — a toast is ephemeral UI state and should not survive a
  // full page reload (it would mean the action is being silently re-triggered, or the toast
  // state is incorrectly persisted somewhere) ─────────────────────────────────────────────────
  const visibleBeforeRefresh = await page.locator(TOAST_SELECTOR).count().catch(() => 0);
  if (visibleBeforeRefresh > 0) {
    const toastTextBefore = await page.locator(TOAST_SELECTOR).first().innerText().catch(() => '');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);
    const visibleAfterRefresh = await page.locator(TOAST_SELECTOR).count().catch(() => 0);
    if (visibleAfterRefresh > 0) {
      const toastTextAfter = await page.locator(TOAST_SELECTOR).first().innerText().catch(() => '');
      if (toastTextAfter === toastTextBefore) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Toasts',
          title: 'Notification persists across a page refresh',
          steps: ['Trigger a notification', 'Refresh the page'],
          expected: 'A transient notification should not reappear after a full page reload',
          actual: `The same notification text ("${toastTextBefore.slice(0, 60)}") is still showing after refresh`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
          confidence: 'heuristic',
          confidenceReason: 'Some apps intentionally persist a notification across a reload (e.g. a server-rendered flash message) — verify this is unintentional before treating as confirmed.',
        });
      }
    } else {
      ctx.onLog('[Toasts] Notification correctly does not persist across a page refresh');
    }
  }

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
