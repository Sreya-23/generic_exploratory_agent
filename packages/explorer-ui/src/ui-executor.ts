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
import { runPrdDrivenFlow } from './flows/prd-driven.js';
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
import {
  runLabelsAria,
  runKeyboardAccess,
  runContrast,
} from './flows/accessibility.js';
import { performLogin, detectLoginWall } from './auth/login.js';
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

/**
 * Returns the path to a saved session state, or null if none exists.
 */
function savedSessionStatePath(ctx: ExecutorContext): string | null {
  const stateFile = join(ctx.sessionsDir, ctx.sessionId, 'auth-state.json');
  return existsSync(stateFile) ? stateFile : null;
}

async function restoreSessionStorage(context: BrowserContext, sessionDir: string, targetUrl: string): Promise<void> {
  const ssFile = join(sessionDir, 'session-storage.json');
  if (!existsSync(ssFile)) return;
  try {
    const raw = readFileSync(ssFile, 'utf-8');
    const entries = Object.entries(JSON.parse(raw) as Record<string, string>);
    if (entries.length === 0) return;
    const { hostname } = new URL(targetUrl);
    await context.addInitScript(
      ({ hostname: host, entries: pairs }) => {
        if (window.location.hostname !== host) return;
        for (const [key, value] of pairs) {
          window.sessionStorage.setItem(key, value);
        }
      },
      { hostname, entries },
    );
  } catch {
    /* ignore corrupt session storage */
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

  const browser = await getBrowser();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

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

    if (isOtpFlow && !creds.otp) {
      // Phase 1 — fill identifier (phone/email) and trigger OTP send
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

      await clickSubmitOnPage(page);
      await page.waitForTimeout(2000); // Give site time to send OTP and show OTP field

      // Phase 2 — pause and collect OTP from user via live chat
      const extras = ctx.onPreActionNeeded?.({
        type: 'otp',
        description: 'OTP sent to your phone. Enter the code to continue.',
        requiredExtras: ['otp'],
      });

      const otp = extras?.['otp'];
      if (!otp) {
        ctx.onLog('[Auth/OTP] OTP not provided — login paused. Enter your OTP in the chat.');
        await context.close();
        return false;
      }

      // Fill OTP
      const filledOtp = await fillFirstMatchOnPage(page, [
        'input[autocomplete="one-time-code"]',
        'input[name*="otp" i]',
        'input[id*="otp" i]',
        'input[name*="code" i]',
        'input[placeholder*="otp" i]',
        'input[placeholder*="code" i]',
        'input[type="text"]',
      ], otp);

      if (!filledOtp) {
        ctx.onLog('[Auth/OTP] OTP field not found after waiting — login failed');
        await context.close();
        return false;
      }

      await clickSubmitOnPage(page);
      await page.waitForTimeout(2000);
      ctx.onLog('[Auth/OTP] OTP submitted');
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

async function fillFirstMatchOnPage(page: Page, selectors: string[], value: string): Promise<boolean> {
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
  'prd-driven': runPrdDrivenFlow,
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
  // E1–E3 — Accessibility (real handlers — do not fall back to navigation)
  'labels': runLabelsAria,
  'keyboard': runKeyboardAccess,
  'contrast': runContrast,
};

export class UiExecutor implements BaseExecutor {
  name = 'ui';
  areas: ExplorationArea[] = ['ui', 'accessibility'];

  async execute(task: FlowTask, ctx: ExecutorContext): Promise<ExecutorResult> {
    let findingsCount = 0;
    const wrappedCtx: ExecutorContext = {
      ...ctx,
      onFinding: (f) => {
        findingsCount++;
        ctx.onFinding(f);
      },
    };

    ctx.onLog(`[UI] Starting: ${task.title}`);

    let page: Page | null = null;
    const TASK_TIMEOUT_MS = 90_000;
    const heartbeat = setInterval(() => {
      ctx.onLog(`[UI] Still working on: ${task.title.slice(0, 80)}…`);
    }, 10_000);

    try {
      page = await createPage(wrappedCtx);
      const startUrl = resolveExplorationStartUrl(ctx);
      await page.goto(startUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Cookies restored but landed on login form (e.g. Sauce Demo `/`) → jump to app
      const landed = await ensureAuthenticatedLanding(page, wrappedCtx);
      if (!landed) {
        await loginIfNeeded(page, wrappedCtx);
        await ensureAuthenticatedLanding(page, wrappedCtx);
      }

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

      return { taskId: task.id, success: true, findingsCount };
    } catch (err) {
      const msg = (err as Error).message;
      ctx.onLog(`[UI] Error: ${msg}`);
      if (page) {
        try {
          const shot = await screenshot(page, ctx, `error-${task.id}`);
          ctx.onFinding({
            severity: 'medium',
            area: 'UI-Error',
            title: `Task error: ${task.title}`,
            steps: [`Navigate to ${ctx.config.targetUrl}`, `Execute ${task.flowClass}`],
            expected: 'Task completes without error',
            actual: msg,
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
