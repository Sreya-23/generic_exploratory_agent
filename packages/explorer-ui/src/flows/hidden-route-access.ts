// §18 — Hidden-but-reachable routes: a link that exists in the DOM (so it came from the
// app's own render tree — never a guessed path) but is hidden or disabled from the current
// view, while its href still points somewhere directly navigable. If that destination renders
// real authenticated content instead of a login wall or a permission-denied message, the UI is
// the only thing gating that action — a classic client-side-only authorization gap: whatever
// role/condition hid the link client-side isn't enforced by the route itself.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { restoreSessionStorage, savedSessionStatePath, isLoginWallPage, waitForRealContent } from './helpers.js';

const MAX_CANDIDATES = 5;
// Never follow a hidden logout link — actually navigating it would end the session this whole
// run depends on, breaking every task scheduled after this one.
const SKIP_HREF_PATTERN = /logout|sign-?out/i;
const PERMISSION_DENIED_PATTERN = /\b(access denied|forbidden|not authoriz|permission denied|you don'?t have (access|permission)|403)\b/i;

interface HiddenLink {
  href: string;
  label: string;
}

async function findHiddenLinks(page: Page): Promise<HiddenLink[]> {
  return page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const out: { href: string; label: string }[] = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
        const style = window.getComputedStyle(a);
        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          a.hasAttribute('hidden') ||
          a.getAttribute('aria-hidden') === 'true' ||
          a.offsetParent === null;
        if (!hidden || seen.has(href)) continue;
        seen.add(href);
        const label = (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 60) || href;
        out.push({ href, label });
      }
      return out;
    })
    .catch(() => []);
}

function recordAccess(
  ctx: ExecutorContext,
  feature: string,
  pageUrl: string,
  directlyReachable: boolean,
  note?: string,
): void {
  ctx.accessMap = [
    ...(ctx.accessMap ?? []),
    { feature, pageUrl, visibleInUi: false, directlyReachable, note },
  ];
}

export async function runHiddenRouteAccessCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const currentUrl = page.url();
  const origin = new URL(currentUrl).origin;

  const hiddenLinks = await findHiddenLinks(page);
  const candidates = hiddenLinks
    .map((link) => {
      try {
        return { url: new URL(link.href, currentUrl).toString(), label: link.label };
      } catch {
        return null;
      }
    })
    .filter((c): c is { url: string; label: string } => !!c && c.url.startsWith(origin) && !SKIP_HREF_PATTERN.test(c.url))
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    ctx.onLog('[HiddenRouteAccess] No hidden-but-linked routes found on this page');
    return;
  }

  ctx.onLog(`[HiddenRouteAccess] Checking ${candidates.length} hidden link(s) for direct reachability: ${candidates.map((c) => c.url).join(', ')}`);

  const savedState = savedSessionStatePath(ctx);
  for (const { url, label } of candidates) {
    const probePage = await page.context().newPage();
    try {
      // A brand-new page/tab doesn't inherit sessionStorage from an existing page even in the
      // same browser context (cookies/localStorage are shared, sessionStorage is not) — same
      // gap the cross-browser check already had to work around.
      if (savedState) {
        await restoreSessionStorage(probePage.context(), join(ctx.sessionsDir, ctx.sessionId), url);
      }
      await probePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await waitForRealContent(probePage).catch(() => {});
      await probePage.waitForTimeout(500);

      const onLoginWall = await isLoginWallPage(probePage).catch(() => false);
      if (onLoginWall) {
        recordAccess(ctx, label, currentUrl, false, 'redirects to login wall');
        ctx.onLog(`[HiddenRouteAccess] ${url} correctly redirects to a login wall — properly gated`);
        continue;
      }

      const bodyText = await probePage.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (PERMISSION_DENIED_PATTERN.test(bodyText)) {
        recordAccess(ctx, label, currentUrl, false, 'shows permission-denied message');
        ctx.onLog(`[HiddenRouteAccess] ${url} shows a permission-denied message — properly gated`);
        continue;
      }

      const contentLength = bodyText.trim().length;
      if (contentLength < 40) {
        // Likely a 404/blank/error page rather than real content — not strong evidence either
        // way, so left out of the access map rather than recorded as a false "not reachable".
        ctx.onLog(`[HiddenRouteAccess] ${url} rendered too little content to judge (${contentLength} chars) — skipping`);
        continue;
      }

      recordAccess(ctx, label, currentUrl, true, `renders ${contentLength} chars of real content`);

      const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `hidden-route-${Date.now()}.png`);
      await probePage.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Authorization',
        title: 'UI-hidden link is directly reachable and renders real content',
        steps: [
          `On ${currentUrl}, a link to ${url} exists in the page's DOM but is hidden from view`,
          `Navigate directly to ${url} in the same authenticated session`,
        ],
        expected: 'A route hidden from the UI for the current user should also be denied (login wall, permission-denied, or 404) when reached directly, or the link should not exist in the DOM at all',
        actual: `${url} rendered ${contentLength} characters of content with no login wall or permission-denied message — the hiding appears to be client-side only`,
        evidence: [shotPath],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: currentUrl,
        confidence: 'heuristic',
        confidenceReason: 'The link is real (found in the live DOM, not guessed), but whether it is hidden due to role/permission vs. an unrelated feature flag or unfinished UI cannot be determined automatically — verify the intent behind hiding it before treating this as a confirmed authorization bug.',
      });
    } finally {
      await probePage.close().catch(() => {});
    }
  }
}
