// B2, B5, B6, B7 — Navigation & Session edge cases
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// B2 — Forward after Back: stale form resubmit
export async function runForwardAfterBack(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[B2] Testing forward-after-back and stale form resubmission');

  const shot = (n: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `fwd-back-${n}.png`);

  const form = page.locator('form').first();
  if ((await form.count()) === 0) {
    ctx.onLog('[B2] No form found');
    return;
  }

  // Fill form
  const textInput = form.locator('input[type="text"], input[type="email"]').first();
  if ((await textInput.count()) > 0) {
    await textInput.fill('b2_test_value');
  }

  const submitBtn = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await submitBtn.count()) === 0) {
    ctx.onLog('[B2] No submit button found');
    return;
  }

  await submitBtn.click().catch(() => {});
  await page.waitForTimeout(1000);
  const s1 = shot('after-submit');
  await page.screenshot({ path: s1 });

  // Go back
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(400);

  // Go forward
  await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(600);

  const s2 = shot('after-forward');
  await page.screenshot({ path: s2 });

  // Check for browser-native "resubmit?" dialog (Playwright auto-accepts these)
  // Check for any "already submitted" warnings or duplicate entries
  const bodyText = await page.locator('body').textContent().catch(() => '');
  if (
    bodyText?.includes('already submitted') ||
    bodyText?.includes('duplicate') ||
    bodyText?.includes('resubmit')
  ) {
    ctx.onLog('[B2] App detected duplicate submission — good');
  } else {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Session',
      title: 'No duplicate detection after Back → Forward over form submission',
      steps: ['Fill and submit form', 'Browser Back', 'Browser Forward'],
      expected: 'App warns about or prevents form resubmission',
      actual: 'No resubmission warning or deduplication detected — verify server-side idempotency',
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: false,
    });
  }
}

// B5 — Deep link without context: missing session
export async function runDeepLink(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[B5] Testing deep links to protected pages without auth session');

  const shot = (n: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `deep-link-${n}.png`);

  const baseUrl = ctx.config.targetUrl.replace(/\/$/, '');

  /**
   * Collect internal links from a page that is already loaded.
   * Includes both href links and common SPA route patterns in JS bundles.
   */
  async function collectPathsFromPage(p: Page, origin: string): Promise<string[]> {
    return p.$$eval(
      'a[href]',
      (els, orig) =>
        els
          .map((a) => {
            try {
              const u = new URL((a as HTMLAnchorElement).href, orig);
              return u.origin === orig ? u.pathname : '';
            } catch { return ''; }
          })
          .filter((path) => Boolean(path) && path !== '/'),
      origin,
    ).catch(() => []);
  }

  // ── Step 1: Collect real paths from the AUTHENTICATED session ──────────────
  // The page is already logged in at this point. Use it to discover real routes
  // (e.g. /inventory.html, /cart.html, /checkout-step-one.html) before wiping session.

  const origin = new URL(ctx.config.targetUrl).origin;
  let discoveredPaths: string[] = [];

  try {
    // Grab links from the current authenticated page
    const currentPaths = await collectPathsFromPage(page, origin);
    discoveredPaths.push(...currentPaths);
    ctx.onLog(`[B5] Collected ${currentPaths.length} paths from current authenticated page (${page.url()})`);

    // BFS-lite: visit up to 3 more pages to find more routes
    const queue = [...new Set(currentPaths)].slice(0, 5);
    const visited = new Set<string>([page.url()]);

    for (const path of queue) {
      if (discoveredPaths.length >= 20) break;
      const url = `${origin}${path}`;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        const morePaths = await collectPathsFromPage(page, origin);
        discoveredPaths.push(...morePaths);
      } catch { /* skip unreachable */ }
    }

    discoveredPaths = [...new Set(discoveredPaths)].filter(
      // Keep meaningful paths only — exclude asset files and anchors
      (p) => p.length > 1 && !p.match(/\.(css|js|png|jpg|svg|ico|woff|map)$/i) && !p.includes('#'),
    );

    ctx.onLog(`[B5] Discovered ${discoveredPaths.length} real site paths from authenticated navigation`);
  } catch (err) {
    ctx.onLog(`[B5] Could not collect authenticated paths: ${err}`);
  }

  // ── Step 2: Fall back to common guesses ONLY if no real paths were found ───
  // This avoids testing routes that don't exist in the app (false "blank page" noise).
  let pathsToTest: string[];

  if (discoveredPaths.length > 0) {
    // We have real paths — test those; no guessing needed
    pathsToTest = discoveredPaths.slice(0, 20);
    ctx.onLog(`[B5] Using ${pathsToTest.length} discovered paths — skipping generic guesses`);
  } else {
    // Login page only, no nav links — fall back to informed guesses
    const commonGuesses = [
      '/dashboard', '/account', '/profile', '/settings', '/admin',
      '/orders', '/checkout', '/cart', '/my-account', '/home',
      '/inventory', '/products', '/users', '/manage',
    ];
    pathsToTest = commonGuesses;
    ctx.onLog(`[B5] No paths discovered from auth session — falling back to ${pathsToTest.length} common guesses`);
  }

  // Clear session before testing
  await page.context().clearCookies();
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* sandboxed */ }
    try { sessionStorage.clear(); } catch { /* sandboxed */ }
  });

  let findingCount = 0;

  for (const path of pathsToTest) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(600);

      const finalUrl = page.url();
      const httpStatus = response?.status() ?? 0;

      // Check 1: HTTP-level protection (server-side redirect or error)
      const httpBlocked = httpStatus === 401 || httpStatus === 403 || httpStatus === 404;
      const isRedirected = finalUrl !== url;
      const urlHintsLogin =
        finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth');

      // Check 2: Client-side router protection — the page rendered but shows the login wall
      const hasPasswordInput = (await page.locator('input[type="password"]').count()) > 0;

      // Check 3: Page has actual meaningful content (rules out 404 blank pages)
      const bodyText = (await page.locator('body').textContent().catch(() => '')) ?? '';
      const trimmedBody = bodyText.trim();
      const hasContent = trimmedBody.length > 150;

      // Check 4: Explicit auth/error text in body
      const bodyLower = trimmedBody.toLowerCase();
      const bodyHintsAuth =
        bodyLower.includes('please log in') ||
        bodyLower.includes('sign in') ||
        bodyLower.includes('unauthorized') ||
        bodyLower.includes('forbidden') ||
        bodyLower.includes('401') ||
        bodyLower.includes('403');

      const isProtected = httpBlocked || isRedirected || urlHintsLogin || hasPasswordInput || bodyHintsAuth;

      if (isProtected) {
        const reason = hasPasswordInput
          ? 'client-side router redirected to login wall'
          : isRedirected
            ? `server redirected to ${finalUrl}`
            : httpBlocked
              ? `HTTP ${httpStatus}`
              : bodyHintsAuth
                ? 'body contains auth hint'
                : 'URL contains login hint';
        ctx.onLog(`[B5] ${path} → protected (${reason})`);
        continue;
      }

      if (!hasContent) {
        // Near-empty response = SPA 404 or server 404 with empty body; route does not exist
        ctx.onLog(`[B5] ${path} → 404/empty (route not present in this app — skipping)`);
        continue;
      }

      // Route exists AND has content AND is not protected — genuine finding
      const s = shot(`deep-${path.replace(/\//g, '-').replace(/^-/, '')}`);
      await page.screenshot({ path: s });

      ctx.onFinding({
        severity: 'high',
        area: 'UI-Session',
        title: `Protected route accessible without session: ${path}`,
        steps: [
          'Clear all cookies and local/session storage',
          `Navigate directly to ${url}`,
          'Check: no redirect, no login wall, page has content',
        ],
        expected: 'Redirect to login page or HTTP 401/403',
        actual: `Page at ${path} rendered ${trimmedBody.length} chars of content without authentication (HTTP ${httpStatus})`,
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
      });
      findingCount++;
    } catch {
      ctx.onLog(`[B5] ${path} → timed out or network error`);
    }
  }

  if (findingCount === 0) {
    ctx.onLog('[B5] All probed paths are properly protected or do not exist');
  }
}

// B6 — Session timeout mid-flow
export async function runSessionTimeout(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[B6] Simulating session timeout by clearing cookies mid-flow');

  const shot = (n: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `session-timeout-${n}.png`);

  // If already on login page and credentials are available, attempt login first.
  // B6 must start from an authenticated state — clearing cookies on an unauthenticated
  // page tests nothing meaningful.
  const alreadyOnLogin = (await page.locator('input[type="password"]').count()) > 0;
  if (alreadyOnLogin) {
    const creds = ctx.config.credentials;
    if (!creds || creds.type === 'none' || !creds.username?.trim() || !creds.password?.trim()) {
      ctx.onLog('[B6] On login page with no credentials configured — skipping (cannot establish session to expire)');
      return;
    }

    ctx.onLog(`[B6] Currently on login page — attempting login as "${creds.username}" to establish a session`);
    const usernameInput = page
      .locator('input[type="text"], input[type="email"], input[name*="user" i]')
      .first();
    const passwordInput = page.locator('input[type="password"]').first();
    const submitBtn = page
      .locator('button[type="submit"], input[type="submit"]')
      .first();

    await usernameInput.fill(creds.username.trim()).catch(() => {});
    await passwordInput.fill(creds.password.trim()).catch(() => {});
    await submitBtn.click().catch(() => {});
    await page.waitForTimeout(2000);

    const stillOnLogin = (await page.locator('input[type="password"]').count()) > 0;
    if (stillOnLogin) {
      ctx.onLog('[B6] Login failed — cannot run session timeout test without an authenticated session');
      return;
    }
    ctx.onLog('[B6] Login succeeded — proceeding with session timeout test');
  }

  const urlBeforeClear = page.url();
  const s1 = shot('before-clear');
  await page.screenshot({ path: s1 });

  // ── Phase 1: Clear ONLY cookies ────────────────────────────────────────────
  // This simulates real-world server-side session expiry: the server marks the
  // cookie as expired/invalid. localStorage and sessionStorage are NOT touched
  // because the browser keeps those across requests.
  // If the app stays logged in after only cookies are cleared, it means auth is
  // stored in localStorage/sessionStorage — a security gap (those persist across
  // tabs, are accessible to XSS, and don't expire with the server session).
  await page.context().clearCookies();
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);

  const s2 = shot('after-cookie-clear');
  await page.screenshot({ path: s2 });

  const urlAfterCookieClear = page.url();
  const hasPasswordInputAfterCookies = (await page.locator('input[type="password"]').count()) > 0;
  const urlHintsLogin = (u: string) =>
    u.includes('login') || u.includes('signin') || u.includes('auth') || u.includes('session');

  const cookieClearLoggedOut =
    hasPasswordInputAfterCookies ||
    urlHintsLogin(urlAfterCookieClear) ||
    urlAfterCookieClear !== urlBeforeClear;

  if (!cookieClearLoggedOut) {
    // App stayed authenticated even after cookies cleared — real security finding
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Session',
      title: 'Session persists after cookies cleared — auth stored outside secure cookie',
      steps: [
        'Log in and reach an authenticated page',
        'Clear all browser cookies (simulating server-side session expiry)',
        'Reload the page',
      ],
      expected: 'App redirects to login page after cookie-based session is removed',
      actual: `Still showing authenticated content at ${urlAfterCookieClear} — auth likely stored in localStorage or sessionStorage, not cookies`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });

    // ── Phase 2: Now also clear localStorage + sessionStorage ──────────────
    // Test whether wiping client-side storage finally logs the user out.
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* sandboxed */ }
      try { sessionStorage.clear(); } catch { /* sandboxed */ }
    });
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(800);

    const s3 = shot('after-full-storage-clear');
    await page.screenshot({ path: s3 });

    const hasPasswordAfterFull = (await page.locator('input[type="password"]').count()) > 0;
    const urlAfterFull = page.url();
    const fullClearLoggedOut =
      hasPasswordAfterFull || urlHintsLogin(urlAfterFull) || urlAfterFull !== urlAfterCookieClear;

    if (fullClearLoggedOut) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Session',
        title: 'Auth state stored in localStorage/sessionStorage — logged out only after full storage wipe',
        steps: [
          'Log in',
          'Clear cookies only → still logged in (finding above)',
          'Also clear localStorage and sessionStorage',
          'Reload',
        ],
        expected: 'Clearing cookies alone should invalidate the session',
        actual: 'Only a full wipe of cookies + localStorage + sessionStorage logs the user out. Session is not cookie-bound.',
        evidence: [s2, s3],
        reproRate: '1/1',
        automationCandidate: true,
      });
      ctx.onLog('[B6] Confirmed: auth is in localStorage/sessionStorage, not cookies');
    } else {
      ctx.onLog('[B6] App stayed logged in even after full storage wipe — may use in-memory state only');
    }
  } else {
    // Cookies alone were enough to log the user out — correct behaviour
    const reason = hasPasswordInputAfterCookies
      ? 'login form appeared (password input detected)'
      : `redirected to ${urlAfterCookieClear}`;
    ctx.onLog(`[B6] Cookie-only clear correctly invalidated session — ${reason}`);

    // ── Phase 2 (pass case): also verify localStorage/sessionStorage is cleaned ──
    // Even if cookies log you out, leftover localStorage data can be a privacy issue
    const leftoverStorage = await page.evaluate(() => {
      const lsKeys = Object.keys(localStorage ?? {});
      const ssKeys = Object.keys(sessionStorage ?? {});
      return { lsKeys, ssKeys };
    }).catch(() => ({ lsKeys: [], ssKeys: [] }));

    if (leftoverStorage.lsKeys.length > 0 || leftoverStorage.ssKeys.length > 0) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Session',
        title: 'Leftover data in localStorage/sessionStorage after session cookie cleared',
        steps: ['Log in', 'Clear cookies', 'Reload', 'Inspect localStorage and sessionStorage'],
        expected: 'All user-specific storage cleared on logout/session expiry',
        actual: `localStorage keys: [${leftoverStorage.lsKeys.join(', ')}], sessionStorage keys: [${leftoverStorage.ssKeys.join(', ')}]`,
        evidence: [s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[B6] No leftover storage after cookie clear — clean session teardown');
    }
  }
}

// B7 — Logout in another tab (silent 401 in active tab)
export async function runMultiTabLogout(
  _page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[B7] Testing logout in another tab while first tab remains active');

  const shot = (n: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `multi-tab-${n}.png`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    const baseUrl = ctx.config.targetUrl;

    // Open site on both tabs
    await tab1.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab2.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // Logout from tab2
    const logoutSelectors = [
      'a:has-text("Logout")',
      'a:has-text("Log out")',
      'button:has-text("Logout")',
      'button:has-text("Sign out")',
      '[href*="logout"]',
      '[href*="signout"]',
    ];

    let loggedOut = false;
    for (const sel of logoutSelectors) {
      if ((await tab2.locator(sel).count()) > 0) {
        await tab2.locator(sel).first().click().catch(() => {});
        await tab2.waitForTimeout(1000);
        loggedOut = true;
        ctx.onLog('[B7] Logged out from tab 2');
        break;
      }
    }

    if (!loggedOut) {
      ctx.onLog('[B7] No logout button found — skipping multi-tab test');
      await context.close();
      return;
    }

    // Now try an action in tab1 that needs auth
    await tab1.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab1.waitForTimeout(600);

    const s1 = shot('tab1-after-logout');
    await tab1.screenshot({ path: s1 });

    const tab1Url = tab1.url();
    const tab1Body = await tab1.locator('body').textContent().catch(() => '');

    const handledGracefully =
      tab1Url.includes('login') ||
      tab1Url.includes('signin') ||
      tab1Body?.toLowerCase().includes('logged out') ||
      tab1Body?.toLowerCase().includes('session') ||
      tab1Body?.toLowerCase().includes('401') ||
      tab1Body?.toLowerCase().includes('403');

    if (!handledGracefully) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Session',
        title: 'Active tab not invalidated after logout from another tab',
        steps: ['Open site in 2 tabs', 'Log out from tab 2', 'Reload tab 1'],
        expected: 'Tab 1 redirects to login or shows "session ended" message',
        actual: `Tab 1 shows content at ${tab1Url} without session expiry notice`,
        evidence: [s1],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[B7] Multi-tab logout handled correctly');
    }

    await context.close();
  } finally {
    await browser.close();
  }
}
