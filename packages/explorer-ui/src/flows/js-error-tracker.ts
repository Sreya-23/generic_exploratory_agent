import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';

interface TrackedJsError {
  message: string;
  url: string;
  source: 'uncaught exception' | 'console.error';
  /** For "Failed to load resource" console errors: the URL that failed (from the console
   *  message's own location) — without it the finding can't say what broke or whose it is. */
  resourceUrl?: string;
  /** Screenshot taken at the moment this error fired, if capture succeeded. */
  screenshotPath?: string;
  /** Which agent check was running when it fired (flow class + title) — some checks disrupt
   *  the app on purpose (clear the login, cut the network), and an error they provoke is not
   *  something a normal user would hit. */
  taskFlow?: string;
  taskTitle?: string;
}

const pageTasks = new WeakMap<Page, { flow: string; title: string }>();

/** Records which check a page belongs to, so errors on it can be attributed. */
export function setPageTask(page: Page, flow: string, title: string): void {
  pageTasks.set(page, { flow, title });
}

// Each task gets a fresh browser context/page (see createPage() in ui-executor.ts) — there is
// no single page object that lives for the whole session. This module-level, session-keyed
// store is what makes error tracking span every task instead of resetting each time, without
// needing to thread a collector object through every flow's signature.
const sessionErrors = new Map<string, Map<string, TrackedJsError>>();
let shotCounter = 0;

const OVERLAY_ID = '__qa_js_error_overlay__';

// A plain screenshot of the page doesn't actually show a CONSOLE error — a reader has no way
// to visually confirm it without re-running the check themselves. Playwright can't screenshot
// the browser's real DevTools panel in headless mode (it isn't part of the page), so instead
// this burns the actual error text directly onto the page before capturing: a fixed banner at
// the top, styled like a console error, so the image is self-explanatory on its own. Injected
// and removed around a single screenshot call — never left on the page afterward, so it can't
// confuse any other check that inspects this same page later.
async function screenshotWithErrorOverlay(
  page: Page,
  ctx: ExecutorContext,
  message: string,
  source: string,
): Promise<string | undefined> {
  try {
    await page.evaluate(
      ({ id, message, source }) => {
        const banner = document.createElement('div');
        banner.id = id;
        banner.style.cssText =
          'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
          'background:#1e1e1e;color:#f14c4c;font:12px/1.5 Menlo,Consolas,monospace;' +
          'padding:10px 14px;white-space:pre-wrap;word-break:break-word;' +
          'border-bottom:2px solid #f14c4c;max-height:35vh;overflow:hidden;';
        banner.textContent = `✕ console.error (${source}): ${message}`;
        document.body.appendChild(banner);
      },
      { id: OVERLAY_ID, message: message.slice(0, 300), source },
    );

    const path = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `js-error-${++shotCounter}.png`);
    await page.screenshot({ path, fullPage: false, timeout: 3000 });
    return path;
  } catch {
    return undefined; // best-effort — a missing screenshot still leaves the error message itself
  } finally {
    await page
      .evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_ID)
      .catch(() => {});
  }
}

/** Call once per newly-created page so its console/runtime errors feed the session's store. */
export function attachErrorTracking(page: Page, ctx: ExecutorContext): void {
  if (!sessionErrors.has(ctx.sessionId)) sessionErrors.set(ctx.sessionId, new Map());
  const store = sessionErrors.get(ctx.sessionId)!;

  page.on('pageerror', (err) => {
    const key = err.message.slice(0, 200);
    if (store.has(key)) return;
    const t = pageTasks.get(page);
    const entry: TrackedJsError = { message: err.message.slice(0, 300), url: page.url(), source: 'uncaught exception', taskFlow: t?.flow, taskTitle: t?.title };
    store.set(key, entry);
    screenshotWithErrorOverlay(page, ctx, entry.message, entry.source).then((path) => {
      if (path) entry.screenshotPath = path;
    });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Strip the #fragment: "/inventory.html" and "/inventory.html#" are the same request and
    // were being reported as two separate findings.
    const resourceUrl = /failed to load resource/i.test(text)
      ? (msg.location()?.url || '').split('#')[0] || undefined
      : undefined;
    const key = `${text.slice(0, 200)}|${resourceUrl ?? ''}`;
    if (store.has(key)) return;
    const t = pageTasks.get(page);
    const entry: TrackedJsError = { message: text.slice(0, 300), url: page.url(), source: 'console.error', resourceUrl, taskFlow: t?.flow, taskTitle: t?.title };
    store.set(key, entry);
    screenshotWithErrorOverlay(page, ctx, entry.message, entry.source).then((path) => {
      if (path) entry.screenshotPath = path;
    });
  });
}

export function getTrackedErrors(sessionId: string): TrackedJsError[] {
  return [...(sessionErrors.get(sessionId)?.values() ?? [])];
}

export function clearTrackedErrors(sessionId: string): void {
  sessionErrors.delete(sessionId);
}
