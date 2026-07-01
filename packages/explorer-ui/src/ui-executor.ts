import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
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
import { performLogin } from './auth/login.js';

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({ headless: true });
  }
  return sharedBrowser;
}

async function createPage(ctx: ExecutorContext): Promise<Page> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  });

  const { config } = ctx;
  if (config.credentials?.type === 'bearer' && config.credentials.bearerToken) {
    await context.setExtraHTTPHeaders({
      Authorization: `Bearer ${config.credentials.bearerToken}`,
    });
  }

  const page = await context.newPage();
  return page;
}

async function loginIfNeeded(page: Page, ctx: ExecutorContext): Promise<void> {
  const creds = ctx.config.credentials;
  if (!creds || creds.type === 'none') return;

  const result = await performLogin(page, creds);
  ctx.onLog(`[Auth] ${result.message}`);
  if (!result.success && result.needsOtp) {
    ctx.onFinding({
      severity: 'high',
      area: 'Auth-OTP',
      title: 'OTP required to continue login',
      steps: ['Enter password', 'Observe OTP prompt'],
      expected: 'OTP provided in session credentials',
      actual: 'OTP field appeared — provide OTP in chat to continue',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: false,
    });
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
  'prd-driven': runNavigation,
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
    try {
      page = await createPage(wrappedCtx);
      await page.goto(ctx.config.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await loginIfNeeded(page, wrappedCtx);

      const handler = FLOW_HANDLERS[task.flowClass];
      if (handler) {
        await handler(page, wrappedCtx, task);
      } else {
        ctx.onLog(`[UI] No handler for flow: ${task.flowClass}, running navigation fallback`);
        await runNavigation(page, wrappedCtx, task);
      }

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
      if (page) await page.context().close();
    }
  }
}

export { runRecon };
export type { ReconResult };
