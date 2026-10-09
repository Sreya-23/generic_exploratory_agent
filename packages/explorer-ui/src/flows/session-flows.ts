// B2, B5, B6, B7 — Navigation & Session edge cases
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { restoreAuthenticatedState, isLoginWallPage } from './helpers.js';

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

  // This whole check is meaningless on a site with no authentication system at all — there is
  // no "session" for cookies to hold in the first place. Confirmed real gap: the only signal
  // used below was "is a password field NOT visible right now," which is equally true for a
  // genuinely logged-in page AND for a site (e.g. a static docs page) that never had a login
  // system to begin with — the latter fell through assuming "must already be authenticated"
  // and then reported clearing cookies "kept the user logged in," which is a category error,
  // not a security finding. Requiring real credentials to be configured before proceeding
  // closes that gap at the source.
  if (!ctx.config.credentials || ctx.config.credentials.type === 'none') {
    ctx.onLog('[B6] No authentication configured for this target — skipping (nothing to test cookie-bound session against)');
    return;
  }

  // If already on a login wall and credentials are available, attempt login first. Uses the
  // same broader isLoginWallPage() the rest of the codebase relies on (covers OTP/segmented
  // entry too, not just a visible password field) — B6 must start from a GENUINELY
  // authenticated state, or clearing cookies tests nothing meaningful.
  const onLoginWall = await isLoginWallPage(page);
  if (onLoginWall) {
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
  } else if (!ctx.postLoginUrl) {
    // Not currently on a login wall, but also no confirmed successful login anywhere earlier
    // in this session (e.g. login silently failed and left the browser on some unauthenticated
    // stub page with no visible password/OTP field) — proceeding here would test cookie-clear
    // behavior on a page that was never actually logged into, the exact category error this
    // whole guard exists to prevent.
    ctx.onLog('[B6] Not on a login wall, but no confirmed successful login this session — skipping to avoid testing an unauthenticated page as if it were logged in');
    return;
  }

  const urlBeforeClear = page.url();
  const s1 = shot('before-clear');
  await page.screenshot({ path: s1 });

  // Whether this app ever relied on a cookie for its session in the first place. Plenty of
  // real, deliberately-designed SPAs are entirely bearer-token/localStorage-based and never
  // set a session cookie at all — for those, "does clearing cookies log you out" isn't a
  // meaningful question (there was nothing to clear that the app was ever using), and it's
  // misleading to report it as if the app failed to honor a cookie-based expiry it never had.
  const cookiesBeforeClear = await page.context().cookies();
  const hadAnyCookies = cookiesBeforeClear.length > 0;

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
    // Reframed around the actual risk (an XSS-readable token) rather than assuming every app
    // is supposed to be cookie-session-based — plenty of real SPAs deliberately use bearer
    // tokens in localStorage and were never relying on a cookie to begin with, which isn't a
    // defect on its own. Severity/framing branches on whether a session cookie even existed:
    // one that was set but silently ignored is a genuine inconsistency worth a "medium" look;
    // an app that never set one at all is just informing a security review, not reporting a
    // broken expiry mechanism it never claimed to have.
    ctx.onFinding({
      severity: hadAnyCookies ? 'medium' : 'low',
      area: 'UI-Session',
      title: hadAnyCookies
        ? 'A session cookie exists but is not what actually gates access — auth token readable from localStorage/sessionStorage'
        : 'Auth token stored in localStorage/sessionStorage, not an httpOnly cookie',
      steps: [
        'Log in and reach an authenticated page',
        'Clear all browser cookies only (localStorage/sessionStorage untouched)',
        'Reload the page',
      ],
      expected: hadAnyCookies
        ? 'If a session cookie is being set, it should be the thing that actually gates access — an ignored cookie alongside a separately-trusted localStorage token is confusing session-management surface, not a coherent single mechanism'
        : 'No specific behavior expected here by default — bearer-token/localStorage auth is a common, valid architecture. Flagged only because a token readable by any injected script carries materially higher exposure than an httpOnly cookie if this app has (or ever gets) an XSS issue elsewhere',
      actual: `Still showing authenticated content at ${urlAfterCookieClear} after clearing cookies — auth is not cookie-bound. ${hadAnyCookies ? `A cookie WAS present before clearing (${cookiesBeforeClear.length} cookie(s)) but evidently isn't what's actually checked.` : 'No cookies were set on this domain at all before clearing — this app appears to be bearer-token/localStorage-based by design.'}`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: hadAnyCookies ? undefined : 'heuristic',
      confidenceReason: hadAnyCookies
        ? undefined
        : 'This is a common, often deliberate architecture choice, not inherently a bug — worth a security-review conversation about XSS exposure, not necessarily a fix.',
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
        steps: [
          `Open ${urlBeforeClear} and log in`,
          'Open DevTools → Application (Chrome) / Storage (Firefox) tab → delete all Cookies for this site',
          'Reload the page',
          'In DevTools → Application → Local Storage and Session Storage for this origin, check for remaining keys',
        ],
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

  // This test deliberately logs the shared page out (that's the whole point of B6) but
  // never logs back in — every task that runs after this one in the same session would
  // otherwise inherit a logged-out page, including flows (cross-browser, device-matrix)
  // that read the shared page's live state as their comparison baseline. Restore it here,
  // once, rather than leaving every later flow to independently discover it's broken.
  const restored = await restoreAuthenticatedState(page, ctx);
  ctx.onLog(
    restored
      ? '[B6] Restored authenticated session for subsequent tasks'
      : '[B6] Could not restore authenticated session — later tasks may see a logged-out page',
  );
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

const LOGOUT_SELECTOR =
  'a:has-text("Logout"), a:has-text("Log out"), a:has-text("Sign out"), ' +
  'button:has-text("Logout"), button:has-text("Log out"), button:has-text("Sign out"), ' +
  '[data-testid*="logout" i], [data-test*="logout" i], [aria-label*="logout" i], [aria-label*="sign out" i], ' +
  '[href*="logout" i], [href*="signout" i]';

/**
 * Checklist (UI) §23 — "Logout and Back button" / "Logout and refresh" / "Protected page after
 * logout," tested as the literal same-tab sequence the checklist names. Previously, logout was
 * only ever tested via the `auth-portal`-site-type-gated journey (never runs on ecommerce/saas/
 * generic sites), via cookie-clearing (B6, a different trigger than an actual logout click), or
 * from a SECOND tab (B7). This clicks a real logout control, generically, on any site type, then
 * runs the exact Back/Refresh/direct-URL sequence against the SAME tab/session.
 *
 * Destructive by nature (ends the real session) — restores it afterward via
 * `restoreAuthenticatedState` so later tasks in this run aren't left logged out, same pattern
 * already established by B6 (`runSessionTimeout`).
 */
export async function runLogoutSessionCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[Logout] Already on a login wall — nothing to log out of');
    return;
  }

  const logoutControl = page.locator(LOGOUT_SELECTOR).first();
  if ((await logoutControl.count()) === 0) {
    ctx.onLog('[Logout] No logout control found on this page — skipping (may be behind a menu this check doesn\'t open)');
    return;
  }

  const protectedUrl = page.url();
  const shot = (name: string) => join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `logout-${name}.png`);

  await logoutControl.click({ force: true, timeout: 5000 }).catch(async () => {
    await logoutControl.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
  });
  await page.waitForTimeout(800);

  const loggedOutAfterClick = await isLoginWallPage(page);
  if (!loggedOutAfterClick) {
    const s = shot('no-redirect');
    await page.screenshot({ path: s }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Session',
      title: 'Logout does not redirect to a login page',
      steps: ['Click the logout control'],
      expected: 'Logging out should land on a login page or otherwise clearly logged-out state',
      actual: `Still appears to be an authenticated page at ${page.url()}`,
      evidence: [s],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog('[Logout] Logout correctly redirects to a login/logged-out state');

    // ── Back button after logout ─────────────────────────────────────────────────────────────
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);
    const protectedAfterBack = !(await isLoginWallPage(page));
    if (protectedAfterBack) {
      const s = shot('back-shows-protected');
      await page.screenshot({ path: s }).catch(() => {});
      ctx.onFinding({
        severity: 'high',
        area: 'UI-Session',
        title: 'Pressing Back after logout reveals the previously-protected page',
        steps: ['Log out', 'Press the browser Back button'],
        expected: 'The protected page should not be shown again after logout (redirect to login, or a cached/stale page with no live data)',
        actual: `Back navigation shows content at ${page.url()} without a login wall`,
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Could be a bfcache-restored static snapshot rather than a live authenticated session — verify whether the data shown is current/real before treating as a security-relevant finding.',
      });
    } else {
      ctx.onLog('[Logout] Back button correctly does not reveal protected content after logout');
    }

    // ── Refresh after logout ─────────────────────────────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);
    const protectedAfterRefresh = !(await isLoginWallPage(page));
    if (protectedAfterRefresh) {
      const s = shot('refresh-shows-protected');
      await page.screenshot({ path: s }).catch(() => {});
      ctx.onFinding({
        severity: 'high',
        area: 'UI-Session',
        title: 'Refreshing after logout still shows the protected page',
        steps: ['Log out', 'Press Back', 'Refresh the page'],
        expected: 'A refresh should never serve the authenticated page after logout',
        actual: `Page at ${page.url()} still shows protected content after refresh`,
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'A full page reload cannot be served from bfcache — this is a genuine live request, so any protected content shown reflects a real server/session gap.',
      });
    } else {
      ctx.onLog('[Logout] Refresh correctly does not restore protected content after logout');
    }

    // ── Direct URL to the original protected page ───────────────────────────────────────────
    await page.goto(protectedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);
    const protectedByDirectUrl = !(await isLoginWallPage(page));
    if (protectedByDirectUrl) {
      const s = shot('direct-url-shows-protected');
      await page.screenshot({ path: s }).catch(() => {});
      ctx.onFinding({
        severity: 'high',
        area: 'UI-Session',
        title: 'Protected page is directly reachable after logout',
        steps: ['Log out', `Navigate directly to ${protectedUrl}`],
        expected: 'Navigating directly to a protected URL after logout should redirect to login',
        actual: `The protected page loaded directly without a login wall`,
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'verified',
        confidenceReason: 'A direct navigation is a fresh request with no history/cache ambiguity — this is a genuine authorization gap if it succeeds.',
      });
    } else {
      ctx.onLog('[Logout] Protected page correctly redirects to login when accessed directly after logout');
    }
  }

  // Restore the session for any later tasks in this run — same precedent as runSessionTimeout.
  const restored = await restoreAuthenticatedState(page, ctx);
  ctx.onLog(
    restored
      ? '[Logout] Session restored for subsequent tasks'
      : '[Logout] Could not restore authenticated session — later tasks may see a logged-out page',
  );
}

/**
 * Checklist (UI) §23 — "Forgot password" reachability. Only tests that the link navigates
 * somewhere real (a different page/content) — actually exercising the reset flow would need a
 * real, disposable email inbox this agent doesn't have, so this deliberately stops at
 * reachability rather than attempting the full reset.
 */
export async function runForgotPasswordCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (!(await isLoginWallPage(page))) {
    ctx.onLog('[ForgotPassword] Not on a login page — skipping');
    return;
  }

  const link = page.locator(
    'a:has-text("Forgot password"), a:has-text("Forgot Password"), a:has-text("Reset password"), button:has-text("Forgot password"), [href*="forgot" i], [href*="reset-password" i]',
  ).first();
  if ((await link.count()) === 0) {
    ctx.onLog('[ForgotPassword] No "Forgot password" link found on this login page — skipping');
    return;
  }

  const urlBefore = page.url();
  const bodyTextBefore = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);

  await link.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  const urlAfter = page.url();
  const bodyTextAfter = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
  const navigated = urlAfter !== urlBefore;
  const contentChanged = Math.abs(bodyTextAfter - bodyTextBefore) > 20;

  if (!navigated && !contentChanged) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Auth',
      title: '"Forgot password" link has no visible effect',
      steps: ['On the login page, click "Forgot password"'],
      expected: 'Clicking should navigate to a password-reset page or open a reset form/modal',
      actual: 'Neither the URL nor the page content changed after clicking',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog(`[ForgotPassword] "Forgot password" link is reachable and leads somewhere (${navigated ? `navigated to ${urlAfter}` : 'content changed in place'})`);
  }

  // Return to the login page for any later tasks in this run.
  if (navigated) {
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}

/**
 * Checklist (UI) §28 — "Session expires during operation." Combines runSessionTimeout's
 * cookie-clearing technique with interruption.ts's mid-request timing: clears cookies
 * IMMEDIATELY after clicking submit (simulating the session expiring mid-flight, rather than
 * B6's "already expired before the user does anything" scenario), then checks the resulting
 * error is clear rather than confusing or — worse — a false success. Destructive to the current
 * session, so restores it afterward like the other checks in this file.
 */
export async function runSessionExpiresDuringOperation(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if ((await submit.count()) === 0) {
    ctx.onLog('[SessionExpire] No form submit found — skipping session-expires-during-operation check');
    return;
  }

  const context = page.context();
  await submit.click().catch(() => {});
  await page.waitForTimeout(100);
  await context.clearCookies().catch(() => {});
  await page.waitForTimeout(1000);

  const showsSuccess = await page.locator('[class*="success" i]:visible, [role="status"]:visible').count().catch(() => 0);
  const nowLoggedOut = await isLoginWallPage(page);

  if (showsSuccess > 0 && !nowLoggedOut) {
    // Ambiguous on its own (could be a message from before the cookie clear) — logged, not
    // flagged, unless paired with clearly stale/authenticated-looking content.
    ctx.onLog('[SessionExpire] A success-looking element is visible after the session expired mid-submit — verify manually whether this reflects a real completed action or a stale pre-expiry message');
  }

  if (!nowLoggedOut) {
    const s = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'session-expire-mid-op.png');
    await page.screenshot({ path: s }).catch(() => {});
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Session',
      title: 'No clear re-authentication prompt after the session expires mid-operation',
      steps: ['Submit a form', 'Immediately clear session cookies (simulating expiry)', 'Observe the result'],
      expected: 'The UI should clearly indicate the session expired and prompt re-login, not silently continue as if authenticated',
      actual: 'No login wall or clear session-expiry indication appeared after the session was cleared mid-request',
      evidence: [s],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'heuristic',
      confidenceReason: 'The in-flight request may have completed using the session state it already held before cookies were cleared (a legitimate race, not a bug) — verify before treating as confirmed.',
    });
  } else {
    ctx.onLog('[SessionExpire] Session expiry mid-operation correctly results in a login wall');
  }

  const restored = await restoreAuthenticatedState(page, ctx);
  ctx.onLog(
    restored
      ? '[SessionExpire] Session restored for subsequent tasks'
      : '[SessionExpire] Could not restore authenticated session — later tasks may see a logged-out page',
  );
}
