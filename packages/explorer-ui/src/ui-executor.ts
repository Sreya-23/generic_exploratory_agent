import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  BaseExecutor,
  ExecutorContext,
  ExecutorResult,
  ExplorationArea,
  FlowTask,
  ReconResult,
} from '@qa/shared';
import { runRecon } from './flows/recon.js';
import { runNavigation } from './flows/navigation.js';
import { runFormValidation } from './flows/forms.js';
import { runInputBoundary } from './flows/boundary.js';
import { runModalLifecycle } from './flows/modals.js';
import { runKeyboardNav } from './flows/keyboard.js';
import { runDoubleClick } from './flows/double-click.js';
import { runEmptyStates } from './flows/empty-states.js';
import { runBackDuringAction } from './flows/interruption.js';
import { runJourneyFlow } from './flows/journey.js';
import { runUserDirectedFlow } from './flows/user-directed.js';
import { runViewport } from './flows/viewport.js';
import { runErrorUi } from './flows/error-ui.js';
import { runAutofill } from './flows/autofill.js';
import { runFileUpload } from './flows/file-upload.js';
import { runPaginationUi } from './flows/pagination-ui.js';
import { runWizard } from './flows/wizard.js';
import {
  runForwardAfterBack,
  runDeepLink,
  runSessionTimeout,
  runMultiTabLogout,
} from './flows/session-flows.js';
import { runGoldenPath, runVisualRegression } from './flows/regression.js';
import { runLabelsCheck, runKeyboardCheck, runContrastCheck } from './flows/accessibility.js';
import { runElementIntegrity, runTouchTargetCheck } from './flows/element-integrity.js';
import { runDeadLinksCheck } from './flows/dead-links.js';
import { runActionInventory } from './flows/action-inventory.js';
import { runDataIntegrityCheck } from './flows/data-integrity.js';
import { runStateTransitionCheck } from './flows/state-transition.js';
import { runHiddenRouteAccessCheck } from './flows/hidden-route-access.js';
import { runGenericCrudCheck } from './flows/generic-crud.js';
import { runCrossBrowserCheck } from './flows/cross-browser.js';
import { runConsentExploration } from './flows/consent-exploration.js';
import { runSecurityHeadersCheck } from './flows/security-headers.js';
import { runBusinessLogicBoundary } from './flows/business-logic-boundary.js';
import { runDeviceMatrixCheck } from './flows/device-matrix.js';
import { runVisualReview } from './flows/visual-review.js';
import { runAgenticExplore } from './flows/agentic-explore.js';
import { runZoomReflow } from './flows/zoom-reflow.js';
import { runDarkModeCheck } from './flows/dark-mode.js';
import { runReducedMotionCheck } from './flows/reduced-motion.js';
import { runWebVitalsCheck } from './flows/web-vitals.js';
import { runConcurrentEditCheck } from './flows/concurrent-edit.js';
import { runLocaleFormatCheck } from './flows/locale-format.js';
import { runOfflinePwaCheck } from './flows/offline-pwa.js';
import { runFocusTrapCheck } from './flows/focus-trap.js';
import { runAutofillOverlapCheck } from './flows/autofill-overlap.js';
import { runLongContentStress } from './flows/long-content.js';
import { runBfcacheCheck } from './flows/bfcache.js';
import { runDownloadVerification } from './flows/download-verify.js';
import { runToastStackingCheck } from './flows/toast-stacking.js';
import { runRtlLayoutCheck } from './flows/rtl-layout.js';
import { runPlaceholderCheck } from './flows/placeholder-check.js';
import { runBrokenImagesCheck } from './flows/broken-images.js';
import { runElementOverflowCheck } from './flows/element-overflow.js';
import { runJsErrorsReport } from './flows/js-errors-report.js';
import { attachErrorTracking } from './flows/js-error-tracker.js';
import { attachVisitTracking } from './flows/page-visit-tracker.js';
import { runCoverageReport } from './flows/coverage-report.js';
import { performLogin, detectLoginWall, checkConsentCheckboxes } from './auth/login.js';
import {
  fillOtpInput,
  isLoginWallPage,
  findVisibleErrorText,
  savedSessionStatePath,
  restoreSessionStorage,
  waitForRealContent,
} from './flows/helpers.js';
import {
  ensureAuthenticatedLanding,
  finalizePostLoginLanding,
  resolveExplorationStartUrl,
} from './auth/post-login.js';

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({ headless: true });
  }
  return sharedBrowser;
}

/**
 * OTP logins pause mid-attempt to wait for the user's real code, which is only known
 * AFTER we've already visited the site and triggered a genuine send. Closing the browser
 * at that pause point (as if every retry could just start fresh) would force the next
 * call to trigger a SECOND real send — racing whichever code the user actually read off
 * their phone, and very likely invalidating it. Keeping the in-progress context/page here
 * lets a later call that finally has the code finish this exact attempt instead of
 * restarting it. Note: an attempt that's never resumed (user never replies) leaks one
 * browser context until process restart — acceptable for a QA tool's session lifetime,
 * not something to build a reaper for here.
 */
const pendingOtpLogins = new Map<string, { context: BrowserContext; page: Page }>();

async function completeOtpLogin(
  ctx: ExecutorContext,
  context: BrowserContext,
  page: Page,
  sessionDir: string,
  otp: string,
): Promise<boolean> {
  const filledOtp = await fillOtpInput(page, otp);
  if (!filledOtp) {
    // Diagnose rather than just fail silently: the OTP field can go missing for real
    // reasons (challenge expired, page redirected) — a screenshot + visible-input dump
    // makes that provable on the next run instead of re-guessing from a bare log line.
    const visibleInputs = await page
      .locator('input:visible')
      .evaluateAll((els) =>
        els.map((el) => ({
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          maxlength: el.getAttribute('maxlength'),
        })),
      )
      .catch(() => []);
    await page
      .screenshot({ path: join(sessionDir, 'otp-fill-failure.png'), fullPage: true })
      .catch(() => {});
    ctx.onLog(
      `[Auth/OTP] OTP field not found — login failed. Page: ${page.url()}. ` +
        `Visible inputs: ${JSON.stringify(visibleInputs)}`,
    );
    await context.close();
    return false;
  }

  await clickSubmitOnPage(page);

  // A correct OTP still needs a real network round-trip (server verification, session write)
  // plus a client-side redirect before the login wall actually clears — a single fixed 2s
  // wait then a ONE-SHOT check could catch that transition mid-flight and wrongly report a
  // genuinely correct code as "rejected." Poll instead, so a slower-but-successful login
  // isn't misdiagnosed as a failure.
  const deadline = Date.now() + 8000;
  let stillOnLoginWall = await isLoginWallPage(page);
  while (stillOnLoginWall && Date.now() < deadline) {
    await page.waitForTimeout(500);
    stillOnLoginWall = await isLoginWallPage(page);
  }

  if (stillOnLoginWall) {
    const errorText = await findVisibleErrorText(page, 500);
    ctx.onLog(
      errorText
        ? `[Auth/OTP] Rejected: ${errorText.slice(0, 120)}`
        : '[Auth/OTP] OTP submitted but still on the login step — the code was likely rejected',
    );
    await context.close();
    return false;
  }

  ctx.onLog('[Auth/OTP] OTP submitted');
  await saveSessionState(context, sessionDir, page);
  const postLoginUrl = await finalizePostLoginLanding(page, sessionDir, ctx.config.targetUrl, (m) => ctx.onLog(m));
  ctx.postLoginUrl = postLoginUrl;
  ctx.onLog(`[Auth] Session saved. Post-login URL: ${postLoginUrl}`);
  await context.close();
  return true;
}

/**
 * Save authenticated session state (cookies + localStorage + sessionStorage).
 * Playwright storageState covers cookies/localStorage; sessionStorage is saved
 * separately because many SPAs (e.g. Sauce Demo) keep auth there.
 */
async function saveSessionState(context: BrowserContext, sessionDir: string, page?: Page): Promise<void> {
  const stateFile = join(sessionDir, 'auth-state.json');
  const state = await context.storageState();
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  if (page) {
    const sessionStorageJson = await page.evaluate(() => JSON.stringify(sessionStorage)).catch(() => '{}');
    writeFileSync(join(sessionDir, 'session-storage.json'), sessionStorageJson);

    const postLoginUrl = page.url();
    writeFileSync(
      join(sessionDir, 'auth-meta.json'),
      JSON.stringify({ postLoginUrl, savedAt: new Date().toISOString() }, null, 2),
    );
  }
}

async function createPage(ctx: ExecutorContext, restoreAuth = true): Promise<Page> {
  const browser = await getBrowser();
  const sessionDir = join(ctx.sessionsDir, ctx.sessionId);

  // Restore authenticated session state if available (avoids re-login for every task)
  const savedState = restoreAuth ? savedSessionStatePath(ctx) : null;
  const contextOptions: Parameters<Browser['newContext']>[0] = {
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  };

  if (savedState) {
    contextOptions.storageState = savedState;
  }

  const context = await browser.newContext(contextOptions);

  if (restoreAuth && savedState) {
    await restoreSessionStorage(context, sessionDir, ctx.config.targetUrl);
  }

  const { config } = ctx;
  if (config.credentials?.type === 'bearer' && config.credentials.bearerToken) {
    await context.setExtraHTTPHeaders({
      Authorization: `Bearer ${config.credentials.bearerToken}`,
    });
  }

  const page = await context.newPage();
  attachErrorTracking(page, ctx);
  attachVisitTracking(page, ctx.sessionId);
  return page;
}

/**
 * Perform login ONCE at session start, save the resulting session state.
 * For OTP flows: fills phone/email, triggers OTP send, then pauses via
 * onPreActionNeeded to collect the code from the user before completing login.
 */
export async function performSessionLogin(ctx: ExecutorContext): Promise<boolean> {
  const creds = ctx.config.credentials;
  if (!creds || creds.type === 'none') return true;
  if (creds.type === 'bearer' || creds.type === 'api-key') return true;

  const sessionDir = join(ctx.sessionsDir, ctx.sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // Already logged in from a previous attempt
  if (existsSync(join(sessionDir, 'auth-state.json'))) {
    ctx.onLog('[Auth] Restoring saved session state');
    return true;
  }

  // A prior call already triggered a real OTP send and is sitting on the OTP entry
  // screen waiting for the code — finish that SAME attempt rather than starting a new
  // browser/navigation (which would trigger a second, different send).
  const pending = pendingOtpLogins.get(ctx.sessionId);
  if (pending) {
    if (!creds.otp) return false; // still nothing to submit — leave the paused attempt as-is
    pendingOtpLogins.delete(ctx.sessionId);
    try {
      return await completeOtpLogin(ctx, pending.context, pending.page, sessionDir, creds.otp);
    } catch (err) {
      ctx.onLog(`[Auth/OTP] Login error: ${(err as Error).message}`);
      await pending.context.close().catch(() => {});
      return false;
    }
  }

  const browser = await getBrowser();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  attachErrorTracking(page, ctx);
  attachVisitTracking(page, ctx.sessionId);

  try {
    ctx.onLog(`[Auth] Navigating to ${ctx.config.targetUrl}`);
    await page.goto(ctx.config.targetUrl, { waitUntil: 'load', timeout: 30000 }).catch(() =>
      page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
    );
    await page.waitForTimeout(1500);

    const method = creds.authMethod ?? 'password';

    // ── OAuth / SSO — inject session cookies provided by user from DevTools ──
    if (method === 'oauth' || method === 'saml') {
      if (creds.cookieString) {
        ctx.onLog('[Auth/OAuth] Injecting session cookies from user');
        const origin = new URL(ctx.config.targetUrl).origin;
        const cookiePairs = creds.cookieString.split(';').map((s) => s.trim()).filter(Boolean);
        for (const pair of cookiePairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) continue;
          const name = pair.slice(0, eqIdx).trim();
          const value = pair.slice(eqIdx + 1).trim();
          await context.addCookies([{ name, value, url: origin }]);
        }
        // Reload with injected cookies
        await page.reload({ waitUntil: 'load' }).catch(() => {});
        await page.waitForTimeout(1000);
      } else if (creds.bearerToken) {
        ctx.onLog('[Auth/OAuth] Bearer token will be used via header injection');
        // Bearer token is already set at context level by createPage()
      } else {
        ctx.onLog('[Auth/OAuth] No cookies or bearer token provided — cannot complete OAuth login');
        await context.close();
        return false;
      }
      await saveSessionState(context, sessionDir, page);
      const postLoginUrl = await finalizePostLoginLanding(
        page,
        sessionDir,
        ctx.config.targetUrl,
        (m) => ctx.onLog(m),
      );
      ctx.postLoginUrl = postLoginUrl;
      ctx.onLog(`[Auth/OAuth] Session saved. Post-login URL: ${postLoginUrl}`);
      await context.close();
      return true;
    }

    // ── Magic-link — navigate to the URL the user received in their email ───
    if (method === 'magic-link') {
      if (creds.magicLinkUrl) {
        ctx.onLog(`[Auth/MagicLink] Navigating to magic link URL`);
        await page.goto(creds.magicLinkUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        // Phase 1: trigger the magic link send
        ctx.onLog('[Auth/MagicLink] Phase 1: filling email to trigger magic link');
        await fillFirstMatchOnPage(page, [
          'input[type="email"]', 'input[name*="email" i]', 'input[type="text"]',
        ], creds.username ?? '');
        await clickSubmitOnPage(page);
        await page.waitForTimeout(1500);

        // Pause — ask user to paste the magic link URL
        const extras = ctx.onPreActionNeeded?.({
          type: 'magic-link' as 'generic',
          description: 'Magic link sent to your email. Paste the full login URL here.',
          requiredExtras: ['magic-link'],
        });

        const linkUrl = extras?.['magic-link'];
        if (!linkUrl) {
          ctx.onLog('[Auth/MagicLink] Magic link URL not provided — login paused');
          await context.close();
          return false;
        }
        await page.goto(linkUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      await saveSessionState(context, sessionDir, page);
      const postLoginUrl = await finalizePostLoginLanding(
        page,
        sessionDir,
        ctx.config.targetUrl,
        (m) => ctx.onLog(m),
      );
      ctx.postLoginUrl = postLoginUrl;
      ctx.onLog(`[Auth/MagicLink] Session saved. Post-login URL: ${postLoginUrl}`);
      await context.close();
      return true;
    }

    const isOtpFlow = method === 'otp' || method === 'password-otp';

    // Reaching this point means there was NO pendingOtpLogins entry for this session (that
    // case is handled earlier and returns before we ever get here) — so this is genuinely
    // the first attempt, and no real OTP has been sent yet in it. Any `creds.otp` already
    // present here cannot be a real code (it was typed before the site had a chance to send
    // one, e.g. pre-filled during initial chat setup alongside the username) — using it
    // would just reproduce the original bug of submitting a guessed/stale value. Always
    // trigger the real send and pause; only a later call via pendingOtpLogins (after the
    // user replies to the actual "OTP sent" prompt) may supply a code that gets used.
    if (isOtpFlow) {
      // Phase 1 — get past whatever the site needs BEFORE it will send a real OTP.
      // Pure OTP: just an identifier (phone/email). Password-then-OTP (2FA): username
      // AND password both have to be submitted first — filling only an identifier here
      // would never reach the point where the site actually sends the second-factor code.
      if (method === 'password-otp' && creds.username && creds.password) {
        ctx.onLog('[Auth/OTP] Phase 1: filling username + password to trigger 2FA OTP');
        await fillFirstMatchOnPage(page, [
          'input[type="email"]', 'input[name*="email" i]', 'input[name*="user" i]', 'input[type="text"]',
        ], creds.username);
        const filledPass = await fillFirstMatchOnPage(page, [
          'input[type="password"]', 'input[name*="pass" i]',
        ], creds.password);
        if (!filledPass) {
          ctx.onLog('[Auth/OTP] Password field not found — skipping login');
          await context.close();
          return false;
        }
      } else {
        ctx.onLog('[Auth/OTP] Phase 1: filling identifier to trigger OTP');
        const filled = await fillFirstMatchOnPage(page, [
          'input[type="tel"]',
          'input[name*="phone" i]',
          'input[name*="mobile" i]',
          'input[placeholder*="phone" i]',
          'input[placeholder*="mobile" i]',
          'input[type="email"]',
          'input[name*="email" i]',
          'input[name*="user" i]',
          'input[type="text"]',
        ], creds.username ?? '');

        if (!filled) {
          ctx.onLog('[Auth/OTP] Could not find phone/email input — skipping login');
          await context.close();
          return false;
        }
      }

      await clickSubmitOnPage(page);
      await page.waitForTimeout(2000); // Give site time to send OTP and show OTP field

      // The real code can only be known once the user reads it off their phone, which
      // can't happen synchronously inside this call. Notify (for the chat prompt), keep
      // the browser open on the OTP screen, and let a later call — once the code is
      // available — pick this exact attempt back up via pendingOtpLogins.
      ctx.onPreActionNeeded?.({
        type: 'otp',
        description: 'OTP sent to your phone. Enter the code to continue.',
        requiredExtras: ['otp'],
      });
      pendingOtpLogins.set(ctx.sessionId, { context, page });
      ctx.onLog('[Auth/OTP] OTP requested — login paused. Enter your OTP in the chat.');
      return false;
    } else {
      // Standard password login
      const result = await performLogin(page, creds);
      ctx.onLog(`[Auth] ${result.message}`);
      if (!result.success) {
        await context.close();
        return false;
      }
    }

    // Save authenticated session state for all tasks
    await saveSessionState(context, sessionDir, page);
    const postLoginUrl = await finalizePostLoginLanding(
      page,
      sessionDir,
      ctx.config.targetUrl,
      (m) => ctx.onLog(m),
    );
    ctx.postLoginUrl = postLoginUrl;
    ctx.onLog(`[Auth] Session saved. Post-login URL: ${postLoginUrl}`);
    await context.close();
    return true;
  } catch (err) {
    ctx.onLog(`[Auth] Login error: ${(err as Error).message}`);
    await context.close();
    return false;
  }
}

/**
 * Waits (bounded, once) for ANY candidate selector to become visible before giving up —
 * a slow-loading SPA (real-world logins are frequently Angular/React apps that take a
 * moment to hydrate) can otherwise cause a same-instant `.count()` check to miss a field
 * that would have appeared a second later, silently failing the whole login attempt.
 */
async function fillFirstMatchOnPage(
  page: Page,
  selectors: string[],
  value: string,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    await page.locator(selectors.join(', ')).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false; // none of the candidates appeared in time — genuinely not on this page
  }

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

async function clickSubmitOnPage(page: Page): Promise<void> {
  await checkConsentCheckboxes(page);
  const submit = page.locator(
    'button[type="submit"], input[type="submit"], ' +
    'button:has-text("Continue"), button:has-text("Send OTP"), button:has-text("Get OTP"), ' +
    'button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), ' +
    'button:has-text("Verify"), button:has-text("Submit"), button:has-text("Next")',
  ).first();
  if ((await submit.count()) > 0) {
    await submit.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
}

async function loginIfNeeded(page: Page, ctx: ExecutorContext): Promise<void> {
  const onLoginWall = await detectLoginWall(page);
  if (!onLoginWall) return;

  const creds = ctx.config.credentials;
  if (!creds || creds.type === 'none') return;
  if (!creds.username || (creds.authMethod !== 'otp' && !creds.password && !creds.otp)) return;

  ctx.onLog('[Auth] Still on login wall after session restore — re-logging in for this task');
  const result = await performLogin(page, creds);
  ctx.onLog(`[Auth] ${result.message}`);

  if (result.success) {
    await page.waitForTimeout(1000);
    if (!(await detectLoginWall(page))) {
      ctx.postLoginUrl = page.url();
      await saveSessionState(page.context(), join(ctx.sessionsDir, ctx.sessionId), page);
    }
  }
}

async function screenshot(page: Page, ctx: ExecutorContext, name: string): Promise<string> {
  const path = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

const FLOW_HANDLERS: Record<
  string,
  (page: Page, ctx: ExecutorContext, task: FlowTask) => Promise<void>
> = {
  recon: runRecon,
  navigation: runNavigation,
  'form-validation': runFormValidation,
  'input-boundary': runInputBoundary,
  'modal-lifecycle': runModalLifecycle,
  'keyboard-nav': runKeyboardNav,
  'double-click': runDoubleClick,
  'empty-states': runEmptyStates,
  'back-during-post': runBackDuringAction,
  'refresh-during-request': runBackDuringAction,
  'context-driven': runNavigation,
  'journey': runJourneyFlow,
  'user-directed': runUserDirectedFlow,
  // A6 — Viewport
  'viewport': runViewport,
  // A9 — Error UI
  'error-ui': runErrorUi,
  // A10 — Autofill
  'autofill': runAutofill,
  // A11 — File Upload
  'file-upload': runFileUpload,
  // A12 — Pagination UI
  'pagination-ui': runPaginationUi,
  // A13 — Wizard
  'wizard': runWizard,
  // B2 — Forward after Back
  'forward-after-back': runForwardAfterBack,
  // B5 — Deep Link
  'deep-link': runDeepLink,
  // B6 — Session Timeout
  'session-timeout': runSessionTimeout,
  // B7 — Multi-tab Logout
  'multi-tab-logout': runMultiTabLogout,
  // H1 — Golden Path
  'golden-path': runGoldenPath,
  // H3 — Visual Regression
  'visual-regression': runVisualRegression,
  // E1/E2/E3 — Accessibility
  'labels': runLabelsCheck,
  'keyboard': runKeyboardCheck,
  'contrast': runContrastCheck,
  // Element integrity
  'element-integrity': runElementIntegrity,
  'touch-target': runTouchTargetCheck,
  // Dead internal links
  'dead-links': runDeadLinksCheck,
  'action-inventory': runActionInventory,
  'data-integrity': runDataIntegrityCheck,
  'state-transition': runStateTransitionCheck,
  'hidden-route-access': runHiddenRouteAccessCheck,
  'generic-crud': runGenericCrudCheck,
  'cross-browser': runCrossBrowserCheck,
  'consent-exploration': runConsentExploration,
  'security-headers': runSecurityHeadersCheck,
  'business-logic-boundary': runBusinessLogicBoundary,
  'device-matrix': runDeviceMatrixCheck,
  'visual-review': runVisualReview,
  'agentic-explore': runAgenticExplore,
  'zoom-reflow': runZoomReflow,
  'dark-mode': runDarkModeCheck,
  'reduced-motion': runReducedMotionCheck,
  'web-vitals': runWebVitalsCheck,
  'concurrent-edit': runConcurrentEditCheck,
  'locale-format': runLocaleFormatCheck,
  'offline-pwa': runOfflinePwaCheck,
  'focus-trap': runFocusTrapCheck,
  'autofill-overlap': runAutofillOverlapCheck,
  'long-content': runLongContentStress,
  'bfcache': runBfcacheCheck,
  'download-verify': runDownloadVerification,
  'toast-stacking': runToastStackingCheck,
  'rtl-layout': runRtlLayoutCheck,
  'placeholder-check': runPlaceholderCheck,
  'broken-images': runBrokenImagesCheck,
  'element-overflow': runElementOverflowCheck,
  'js-errors': runJsErrorsReport,
  'coverage-report': runCoverageReport,
};

// Both flows call out to Gemini and document themselves as purely additive — skipping
// gracefully, never affecting any other task, if that call is slow/unavailable/fails. A
// timeout at the outer task level is this agent's own infrastructure, not a target-site
// observation, so it's excluded from the generic "Task error" finding below rather than
// being misreported as a defect in the site under test.
const SELF_GATING_OPTIONAL_FLOWS = new Set(['visual-review', 'agentic-explore']);

export class UiExecutor implements BaseExecutor {
  name = 'ui';
  areas: ExplorationArea[] = ['ui', 'accessibility'];

  async execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult> {
    let findingsCount = 0;
    // Snapshot the references BEFORE the spread — used after the flow runs to tell "this
    // task's flow genuinely set a new value" apart from "wrappedCtx just inherited whatever
    // ctx already had." Without that distinction, copying these fields back after EVERY task
    // (not just the one that owns each field) re-triggers the orchestrator's merge-into-state
    // logic every task for the rest of the session — for array fields like actionInventory
    // that merge by concatenation, that reappends the same entries on every subsequent task,
    // unboundedly growing session state until it can no longer be JSON-serialized.
    const before = {
      discoveredApiEndpoints: ctx.discoveredApiEndpoints,
      postLoginUrl: ctx.postLoginUrl,
      actionInventory: ctx.actionInventory,
      discoveredRoutes: ctx.discoveredRoutes,
      visitedRoutes: ctx.visitedRoutes,
    };
    const wrappedCtx: ExecutorContext = {
      ...ctx,
      onFinding: (f) => {
        findingsCount++;
        ctx.onFinding(f);
      },
    };

    ctx.onLog(`[UI] Starting: ${task.title}`);

    let page: Page | null = null;
    // Fail faster once the orchestrator has flagged the target as currently degraded — no
    // point spending a full 90s repeating a failure several other tasks just hit in a row.
    const TASK_TIMEOUT_MS = ctx.envDegraded ? 30_000 : 90_000;
    const heartbeat = setInterval(() => {
      ctx.onLog(`[UI] Still working on: ${task.title.slice(0, 80)}…`);
    }, 10_000);

    try {
      page = await createPage(wrappedCtx);
      const startUrl = resolveExplorationStartUrl(ctx);
      try {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (gotoErr) {
        // A single timeout is often a transient blip (target briefly slow/overloaded), not a
        // permanent failure — retry once before burning this task's whole budget on what may
        // just be bad luck this instant. Observed repeatedly against real demo sites this way.
        ctx.onLog(
          `[UI] Initial page load timed out, retrying once: ${(gotoErr as Error).message.slice(0, 100)}`,
        );
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Cookies restored but landed on login form (e.g. Sauce Demo `/`) → jump to app
      const landed = await ensureAuthenticatedLanding(page, wrappedCtx);
      if (!landed) {
        await loginIfNeeded(page, wrappedCtx);
        await ensureAuthenticatedLanding(page, wrappedCtx);
      }

      // Tick any visible consent/terms checkbox as routine hygiene before handing off to the
      // flow handler — not just when explicitly logging in. Many forms (this one included)
      // disable their primary action until "I agree to Terms & Conditions" is checked; when
      // no login credentials are configured at all, performSessionLogin never runs and never
      // gets a chance to do this, leaving every generic check (Action Inventory, etc.)
      // confused by a button that looks broken but is actually just gated on an unticked box.
      await checkConsentCheckboxes(page).catch(() => {});

      // Give the page a chance to genuinely finish rendering before handing off to the flow —
      // confirmed real gap: a dashboard's static sidebar/logo text can clear a "there's some
      // text" threshold well before any actual button/link/input has mounted, leaving flows
      // like Action Inventory to scan a page that LOOKS loaded but has zero interactive
      // elements yet. Every flow gets this for free now instead of each having to remember to
      // call waitForRealContent itself (many already do, redundantly but harmlessly).
      await waitForRealContent(page);

      const handler = FLOW_HANDLERS[task.flowClass];
      const run = async () => {
        if (handler) {
          await handler(page!, wrappedCtx, task);
        } else {
          ctx.onLog(`[UI] No handler for flow: ${task.flowClass}, running navigation fallback`);
          await runNavigation(page!, wrappedCtx, task);
        }
      };

      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Task timeout after ${TASK_TIMEOUT_MS / 1000}s — aborted to keep the session moving`,
              ),
            );
          }, TASK_TIMEOUT_MS);
        }),
      ]);

      // wrappedCtx is a SEPARATE object from ctx (built via `{...ctx, onFinding}` above) — a
      // flow setting wrappedCtx.discoveredApiEndpoints/postLoginUrl/actionInventory/etc. only
      // ever mutates that throwaway copy. Copy each field back onto the original ctx only if
      // THIS task's flow actually reassigned it (reference changed from the `before` snapshot)
      // — otherwise every task after the one that first set a field would re-copy the same
      // inherited value and re-trigger the orchestrator's merge-into-state logic needlessly.
      if (wrappedCtx.discoveredApiEndpoints !== before.discoveredApiEndpoints) {
        ctx.discoveredApiEndpoints = wrappedCtx.discoveredApiEndpoints;
      }
      if (wrappedCtx.postLoginUrl !== before.postLoginUrl) {
        ctx.postLoginUrl = wrappedCtx.postLoginUrl;
      }
      if (wrappedCtx.actionInventory !== before.actionInventory) {
        ctx.actionInventory = wrappedCtx.actionInventory;
      }
      if (wrappedCtx.discoveredRoutes !== before.discoveredRoutes) {
        ctx.discoveredRoutes = wrappedCtx.discoveredRoutes;
      }
      if (wrappedCtx.visitedRoutes !== before.visitedRoutes) {
        ctx.visitedRoutes = wrappedCtx.visitedRoutes;
      }

      return { taskId: task.id, success: true, findingsCount };
    } catch (err) {
      const msg = (err as Error).message;
      ctx.onLog(`[UI] Error: ${msg}`);
      // visual-review and agentic-explore both call out to Gemini and explicitly document
      // themselves as "never blocks, never affects any other task" if that call is slow,
      // unavailable, or fails — a timeout here is this agent's own infrastructure not
      // completing in time, not an observation about the target site, and reporting it as a
      // "UI-Error: Task error" finding directly contradicts that documented behavior by
      // presenting an internal failure as if it were evidence of a site defect.
      if (SELF_GATING_OPTIONAL_FLOWS.has(task.flowClass)) {
        ctx.onLog(
          `[UI] "${task.title}" did not complete (likely a slow/unavailable Gemini call) — skipping without reporting a finding, per this flow's own graceful-failure design`,
        );
        return { taskId: task.id, success: false, findingsCount };
      }
      if (page) {
        try {
          const shot = await screenshot(page, ctx, `error-${task.id}`);
          // task.flowClass (e.g. "journey") is an internal code identifier, not something a
          // reader can act on — "Execute journey" means nothing to anyone outside this
          // codebase. Explain what the agent was actually doing, and translate the common
          // "page took too long to load" case into plain language rather than a raw
          // Playwright stack-trace-style message.
          const isGotoTimeout = /page\.goto:.*Timeout/i.test(msg);
          ctx.onFinding({
            severity: 'medium',
            area: 'UI-Error',
            title: `Task error: ${task.title}`,
            steps: [
              `The agent was running its "${task.title}" check against ${ctx.config.targetUrl}`,
              'This check did not complete — see "Actual" below for what went wrong',
            ],
            expected: 'Task completes without error',
            actual: isGotoTimeout
              ? `The page took longer than 30 seconds to load and the check gave up — likely the ` +
                `target site was slow or briefly unavailable, not necessarily a defect in the ` +
                `app itself. Raw error: ${msg}`
              : msg,
            evidence: [shot],
            reproRate: '1/1',
            automationCandidate: true,
          });
          findingsCount++;
        } catch {
          /* ignore screenshot failure */
        }
      }
      return { taskId: task.id, success: false, findingsCount, error: msg };
    } finally {
      clearInterval(heartbeat);
      if (page) await page.context().close();
    }
  }
}

export { runRecon };
export type { ReconResult };
