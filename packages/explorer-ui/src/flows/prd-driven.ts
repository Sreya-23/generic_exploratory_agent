import { join } from 'node:path';
import type { Page } from 'playwright';
import type {
  ExecutorContext,
  FlowTask,
  PrdFeatureCoverage,
  PrdFeatureStatus,
  PrdTestVariant,
} from '@qa/shared';
import { fillExtras } from './user-directed.js';
import { findVisibleErrorText, isLoginWallPage } from './helpers.js';
import {
  assertAuthenticatedApp,
  assertCheckoutOverviewGuards,
  assertLogoutSuccess,
  countCartLineItems,
  countInventoryItems,
  exerciseInventorySort,
  getCartBadgeCount,
  getInputValue,
  isCartUrl,
  isCheckoutCompleteUrl,
  isCheckoutStepUrl,
  isHarnessBlankUrl,
  pageLooksHealthy,
  readVisibleTotals,
  removeFirstCartItem,
  seedHistoryForBack,
} from './prd-assertions.js';
import { quarantineKnownQuirk } from './prd-quirks.js';
import {
  ensureAuthenticatedLanding,
  hasSavedAuthState,
  isLoginRelatedFeature,
  readPostLoginUrl,
  resolveExplorationStartUrl,
} from '../auth/post-login.js';

type Intent =
  | 'login'
  | 'inventory'
  | 'cart'
  | 'checkout'
  | 'logout'
  | 'add-to-cart'
  | 'search'
  | 'filter'
  | 'form'
  | 'table'
  | 'upload'
  | 'profile'
  | 'wishlist'
  | 'generic';

interface TraceCtx {
  feature: string;
  variant: PrdTestVariant;
  requirementId?: string;
  taskId: string;
  criteria?: string;
}

async function shot(page: Page, ctx: ExecutorContext, taskId: string, label: string): Promise<string> {
  const safeTask = taskId.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24);
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${safeTask}-${safeLabel}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

function reportCoverage(
  ctx: ExecutorContext,
  trace: TraceCtx,
  status: PrdFeatureStatus,
  notes: string,
  findingsCount: number,
): void {
  const update: PrdFeatureCoverage = {
    feature: trace.feature,
    variant: trace.variant,
    status,
    notes,
    findingsCount,
    requirementId: trace.requirementId,
    taskId: trace.taskId,
    criteria: trace.criteria,
  };
  ctx.onPrdCoverageUpdate?.(update);
}

function findingTitle(trace: TraceCtx, title: string): string {
  const prefix = trace.requirementId ? `[${trace.requirementId}] ` : '';
  return `${prefix}${title}`;
}

function emitFinding(
  ctx: ExecutorContext,
  trace: TraceCtx,
  partial: Parameters<ExecutorContext['onFinding']>[0],
): void {
  const drafted = quarantineKnownQuirk(ctx.config.targetUrl, {
    ...partial,
    title: findingTitle(trace, partial.title),
    requirementId: trace.requirementId,
    taskId: trace.taskId,
  });
  // Quarantined quirks should not inflate "failed" coverage — callers still control that;
  // but info-severity quarantines are clearly tagged for the report.
  ctx.onFinding(drafted);
}

function featureKeywords(feature: string): string[] {
  const stop = new Set([
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'with', 'as',
    'user', 'users', 'system', 'shall', 'must', 'should', 'want', 'able', 'can',
    'that', 'this', 'from', 'into', 'will', 'be', 'is', 'are', 'have', 'has',
    'so', 'my', 'their', 'our', 'via', 'using',
  ]);
  return feature
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 8);
}

function featureIntent(feature: string): Intent {
  const f = feature.toLowerCase();
  if (isLoginRelatedFeature(f)) return 'login';
  if (/\blog ?out\b|\bsign ?out\b/.test(f)) return 'logout';
  if (/\bcheckout\b|\bpurchase\b|\bplace order\b|\bbuy\b|\bpayment\b/.test(f)) return 'checkout';
  if (/\badd to cart\b|\badd-to-cart\b/.test(f)) return 'add-to-cart';
  if (/\bwishlist\b|\bsave for later\b|\bfavorites?\b/.test(f)) return 'wishlist';
  if (/\bcart\b|\bbasket\b/.test(f)) return 'cart';
  if (/\bsearch\b|\bfind\b|\bquery\b/.test(f)) return 'search';
  if (/\bfilter\b|\bfacet\b|\bsort\b/.test(f)) return 'filter';
  if (/\bupload\b|\battach\b|\bfile\b/.test(f)) return 'upload';
  if (/\btable\b|\bgrid\b|\blisting\b|\bdata grid\b|\brows?\b/.test(f)) return 'table';
  if (/\bprofile\b|\baccount\b|\bsettings?\b|\bpreferences?\b/.test(f)) return 'profile';
  if (/\bform\b|\bregister\b|\bsign ?up\b|\bsubmit\b|\bcontact\b|\baddress\b/.test(f)) return 'form';
  if (/\binventory\b|\bproduct\b|\bcatalog\b|\bbrowse\b|\blisting\b/.test(f)) return 'inventory';
  return 'generic';
}

async function openCart(page: Page, ctx: ExecutorContext): Promise<boolean> {
  const cart = page
    .locator(
      '.shopping_cart_link, a.shopping_cart_link, #shopping_cart_container a, [data-test="shopping-cart-link"], a[href*="cart"]',
    )
    .first();
  if ((await cart.count()) > 0 && (await cart.isVisible().catch(() => false))) {
    await cart.click({ timeout: 3000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);
    ctx.onLog('[PRD] Opened cart');
    return true;
  }
  return false;
}

async function addFirstProductToCart(page: Page, ctx: ExecutorContext): Promise<boolean> {
  const btn = page
    .locator(
      'button:has-text("Add to cart"), button:has-text("Add to Cart"), [data-test^="add-to-cart"]',
    )
    .first();
  if ((await btn.count()) === 0) return false;
  await btn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  ctx.onLog('[PRD] Clicked Add to cart');
  return true;
}

/** Seed cart so View Cart / Checkout start from a known state */
async function ensureInventoryWithAddButtons(page: Page, ctx: ExecutorContext): Promise<boolean> {
  const addSel =
    'button:has-text("Add to cart"), button:has-text("Add to Cart"), [data-test^="add-to-cart"]';
  await ensureAuthenticatedLanding(page, ctx);
  if ((await page.locator(addSel).count()) > 0) return true;

  const origin = new URL(ctx.config.targetUrl).origin;
  const candidates = [
    resolveExplorationStartUrl(ctx),
    `${origin}/inventory.html`,
    `${origin}/inventory`,
    `${origin}/`,
  ];
  for (const url of candidates) {
    ctx.onLog(`[PRD] Need inventory Add buttons — navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await ensureAuthenticatedLanding(page, ctx);
    if ((await page.locator(addSel).count()) > 0) return true;
  }
  return false;
}

async function seedCart(page: Page, ctx: ExecutorContext, minItems = 1): Promise<number> {
  await ensureInventoryWithAddButtons(page, ctx);
  let badge = await getCartBadgeCount(page);
  let attempts = 0;
  while (badge < minItems && attempts < 4) {
    const clicked = await addFirstProductToCart(page, ctx);
    if (!clicked) {
      // Might be on cart/overview — force inventory again
      await ensureInventoryWithAddButtons(page, ctx);
      if (!(await addFirstProductToCart(page, ctx))) break;
    }
    badge = await getCartBadgeCount(page);
    attempts++;
  }
  return badge;
}

async function openBurgerLogout(page: Page): Promise<boolean> {
  const burger = page.locator('#react-burger-menu-btn, button:has-text("Open Menu")').first();
  if ((await burger.count()) > 0) {
    await burger.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const logout = page
    .locator('#logout_sidebar_link, a:has-text("Logout"), button:has-text("Logout")')
    .first();
  if ((await logout.count()) > 0) {
    await logout.click({ timeout: 2000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function clickPrimarySubmit(page: Page): Promise<boolean> {
  const submit = page
    .locator(
      'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Save"), button:has-text("Continue"), button:has-text("Next"), button:has-text("Create"), button:has-text("Add"), button:has-text("Login"), button:has-text("Checkout"), button:has-text("Finish"), [data-test="continue"], [data-test="finish"], [data-test="login-button"]',
    )
    .first();
  if ((await submit.count()) === 0) return false;
  await submit.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function fillSafePlaceholders(page: Page, ctx: ExecutorContext): Promise<number> {
  const extras = ctx.config.credentials?.extras;
  if (extras && Object.keys(extras).length > 0) {
    await fillExtras(page, extras);
  }

  const inputs = page.locator('input:visible, textarea:visible');
  const count = await inputs.count().catch(() => 0);
  let filled = 0;

  for (let i = 0; i < Math.min(count, 8); i++) {
    const input = inputs.nth(i);
    const type = ((await input.getAttribute('type')) ?? 'text').toLowerCase();
    if (
      ['password', 'email', 'tel', 'file', 'hidden', 'checkbox', 'radio', 'submit', 'button'].includes(
        type,
      )
    ) {
      continue;
    }

    const name = ((await input.getAttribute('name')) ?? '').toLowerCase();
    const placeholder = ((await input.getAttribute('placeholder')) ?? '').toLowerCase();
    const aria = ((await input.getAttribute('aria-label')) ?? '').toLowerCase();
    const id = ((await input.getAttribute('id')) ?? '').toLowerCase();
    const hint = `${name} ${placeholder} ${aria} ${id}`;
    if (
      /email|phone|mobile|card|cvv|password|otp|aadhar|pan|bank|recipient|whatsapp|sms|username|user-name/.test(
        hint,
      )
    ) {
      continue;
    }

    if (/first[\s_-]*name|firstname|last[\s_-]*name|lastname|postal|zip/.test(hint)) {
      const value = /first/.test(hint) ? 'QA' : /last/.test(hint) ? 'Tester' : '560001';
      await input.fill(value).catch(() => {});
      filled++;
      continue;
    }

    const value = type === 'number' ? '1' : 'QA test value';
    await input.fill(value).catch(() => {});
    filled++;
  }

  return filled;
}

async function locateFeatureUi(
  page: Page,
  ctx: ExecutorContext,
  feature: string,
): Promise<boolean> {
  const intent = featureIntent(feature);
  ctx.onLog(`[PRD] Feature intent=${intent} for: ${feature.slice(0, 80)}`);

  if (intent === 'login') {
    await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(400);
    return await isLoginWallPage(page);
  }

  if (intent === 'logout') {
    return true; // logout is performed in happy/negative paths deliberately
  }

  if (intent === 'inventory') {
    const items = await countInventoryItems(page);
    if (items > 0) return true;
    const productLink = page.locator('a[href*="inventory"], .inventory_item_name, a[id*="item"]').first();
    if ((await productLink.count()) > 0) {
      await productLink.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
      return (await countInventoryItems(page)) > 0;
    }
    return false;
  }

  if (intent === 'add-to-cart') {
    return (await countInventoryItems(page)) > 0;
  }

  if (intent === 'cart') {
    await seedCart(page, ctx, 1);
    return openCart(page, ctx);
  }

  if (intent === 'checkout') {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
    const checkout = page
      .locator(
        'button:has-text("Checkout"), [data-test="checkout"], a:has-text("Checkout"), button:has-text("Proceed")',
      )
      .first();
    if ((await checkout.count()) > 0) {
      await checkout.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      ctx.onLog('[PRD] Opened checkout');
      return (
        isCheckoutStepUrl(page.url()) ||
        (await page.locator('#first-name, [data-test="firstName"]').count()) > 0
      );
    }
    return false;
  }

  if (intent === 'search') {
    const search = page
      .locator(
        'input[type="search"], input[name*="search" i], input[placeholder*="search" i], [data-test*="search"] input, #search',
      )
      .first();
    if ((await search.count()) > 0) {
      await search.fill('qa', { timeout: 3000 }).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(500);
      return true;
    }
    return (await page.locator('input[type="search"], input[placeholder*="Search" i]').count()) > 0;
  }

  if (intent === 'filter') {
    const filter = page
      .locator(
        'select, [role="listbox"], button:has-text("Filter"), [data-test*="filter"], [data-test*="sort"]',
      )
      .first();
    if ((await filter.count()) > 0) {
      await filter.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
    return (await exerciseInventorySort(page)).startsWith('sort:');
  }

  if (intent === 'upload') {
    const file = page.locator('input[type="file"]').first();
    return (await file.count()) > 0;
  }

  if (intent === 'table') {
    const rows = page.locator('table tbody tr, [role="row"], .data-row, .ag-row');
    return (await rows.count()) > 0;
  }

  if (intent === 'profile' || intent === 'form' || intent === 'wishlist') {
    const keywords = featureKeywords(feature);
    for (const keyword of keywords) {
      const el = page
        .locator(
          `a:has-text("${keyword}"), button:has-text("${keyword}"), [role="link"]:has-text("${keyword}")`,
        )
        .first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
        return true;
      }
    }
    if (intent === 'form') {
      return (await page.locator('form, input:visible, textarea:visible').count()) > 0;
    }
    return !(await isLoginWallPage(page));
  }

  const keywords = featureKeywords(feature);
  for (const keyword of keywords) {
    const candidates = page.locator(
      `a:has-text("${keyword}"), button:has-text("${keyword}"), [role="tab"]:has-text("${keyword}"), [role="menuitem"]:has-text("${keyword}")`,
    );
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(400);
      ctx.onLog(`[PRD] Opened UI via "${keyword}"`);
      return true;
    }
  }

  const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
  if (keywords.some((k) => body.includes(k))) {
    ctx.onLog('[PRD] Feature keywords already visible on current page');
    return true;
  }

  if (!(await isLoginWallPage(page)) && keywords.length > 0) {
    ctx.onLog('[PRD] No exact match — staying on authenticated app page for observation');
    return true;
  }

  return false;
}

async function runAuthSmokeGate(
  page: Page,
  ctx: ExecutorContext,
  trace: TraceCtx,
): Promise<void> {
  const s1 = await shot(page, ctx, trace.taskId, 'before');
  const checks: string[] = [];

  if (!hasSavedAuthState(ctx)) {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Smoke',
      title: 'Auth smoke failed — no auth-state.json',
      steps: ['Complete pre-session login', 'Verify auth-state.json exists'],
      expected: 'auth-state.json present for session restore',
      actual: 'Missing auth-state.json — PRD feature tests would be unreliable',
      evidence: [s1],
      reproRate: '1/1',
      automationCandidate: false,
    });
    reportCoverage(ctx, trace, 'failed', 'No auth-state.json after login', 1);
    return;
  }
  checks.push('auth-state.json present');

  const postLogin = readPostLoginUrl(ctx);
  if (!postLogin) {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Smoke',
      title: 'Auth smoke failed — no post-login-url.txt',
      steps: ['Login once', 'Persist post-login URL'],
      expected: 'post-login-url.txt saved (e.g. /inventory.html)',
      actual: 'Missing post-login URL — tasks may open the login page',
      evidence: [s1],
      reproRate: '1/1',
      automationCandidate: true,
    });
    reportCoverage(ctx, trace, 'failed', 'No post-login-url.txt', 1);
    return;
  }
  checks.push(`post-login-url=${postLogin}`);

  await page.goto(resolveExplorationStartUrl(ctx), { waitUntil: 'domcontentloaded' }).catch(() => {});
  const landed = await ensureAuthenticatedLanding(page, ctx);
  const s2 = await shot(page, ctx, trace.taskId, 'after');

  if (!landed || (await isLoginWallPage(page))) {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Smoke',
      title: 'Auth smoke failed — still on login wall',
      steps: ['Restore storageState', `Open ${postLogin}`, 'Assert not login wall'],
      expected: 'Authenticated landing page',
      actual: `Login wall at ${page.url()}`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
    reportCoverage(ctx, trace, 'failed', `Login wall after restore (${page.url()})`, 1);
    return;
  }

  const auth = await assertAuthenticatedApp(page);
  if (!auth.ok) {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Smoke',
      title: 'Auth smoke failed — authenticated app not detected',
      steps: ['Open post-login URL', 'Assert products/nav/cart'],
      expected: 'Authenticated app signals',
      actual: auth.detail,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
    reportCoverage(ctx, trace, 'failed', auth.detail, 1);
    return;
  }

  reportCoverage(ctx, trace, 'passed', `Smoke OK — ${checks.join('; ')}; ${auth.detail}`, 0);
}

async function assertHappyOutcome(
  page: Page,
  intent: Intent,
): Promise<{ ok: boolean; detail: string }> {
  if (intent === 'login') {
    if (await isLoginWallPage(page)) {
      return { ok: false, detail: 'Still on login wall after login happy path' };
    }
    return assertAuthenticatedApp(page);
  }

  if (intent === 'inventory') {
    const n = await countInventoryItems(page);
    if (n > 0) return { ok: true, detail: `Inventory shows ${n} product(s) at ${page.url()}` };
    return { ok: false, detail: `Expected products listing; found 0 at ${page.url()}` };
  }

  if (intent === 'add-to-cart') {
    const badge = await getCartBadgeCount(page);
    const removeBtn = await page
      .locator('button:has-text("Remove"), [data-test^="remove"]')
      .count();
    if (badge >= 1 || removeBtn > 0) {
      return { ok: true, detail: `Cart badge=${badge}, removeButtons=${removeBtn}` };
    }
    return { ok: false, detail: `Add to cart did not increase badge (badge=${badge})` };
  }

  if (intent === 'cart') {
    const onCart = isCartUrl(page.url());
    const lines = await countCartLineItems(page);
    if (onCart && lines >= 1) {
      return { ok: true, detail: `Cart page with ${lines} line item(s) at ${page.url()}` };
    }
    return {
      ok: false,
      detail: `Expected cart page with items; onCart=${onCart}, lines=${lines}, url=${page.url()}`,
    };
  }

  if (intent === 'checkout') {
    const complete = isCheckoutCompleteUrl(page.url());
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
    const thanks = /thank you|order complete|dispatched|checkout complete|pony express/i.test(body);
    if (complete || thanks) {
      return { ok: true, detail: `Checkout complete at ${page.url()}` };
    }
    return { ok: false, detail: `Checkout did not reach completion page (${page.url()})` };
  }

  if (intent === 'logout') {
    return assertLogoutSuccess(page);
  }

  if (intent === 'search') {
    const healthy = await pageLooksHealthy(page);
    return {
      ok: healthy,
      detail: healthy ? `Search UI exercised at ${page.url()}` : `Search left unhealthy page`,
    };
  }

  if (intent === 'table') {
    const rows = await page.locator('table tbody tr, [role="row"], .data-row').count();
    return {
      ok: rows > 0,
      detail: rows > 0 ? `Table/grid shows ${rows} row(s)` : 'No table rows found',
    };
  }

  if (intent === 'upload') {
    const file = await page.locator('input[type="file"]').count();
    return {
      ok: file > 0,
      detail: file > 0 ? 'File upload input present' : 'No file upload input',
    };
  }

  if (intent === 'form' || intent === 'profile') {
    const fields = await page.locator('input:visible, textarea:visible, select:visible').count();
    return {
      ok: fields > 0 || (await pageLooksHealthy(page)),
      detail: `Form/profile fields=${fields} url=${page.url()}`,
    };
  }

  if (intent === 'wishlist' || intent === 'filter') {
    const healthy = await pageLooksHealthy(page);
    return { ok: healthy, detail: `${intent} page healthy=${healthy} at ${page.url()}` };
  }

  const healthy = await pageLooksHealthy(page);
  return {
    ok: healthy,
    detail: healthy ? `Page healthy at ${page.url()}` : `Unhealthy page at ${page.url()}`,
  };
}

async function runHappyPath(
  page: Page,
  ctx: ExecutorContext,
  trace: TraceCtx,
): Promise<void> {
  const intent = featureIntent(trace.feature);
  const s1 = await shot(page, ctx, trace.taskId, 'before');

  if (intent === 'login') {
    if (hasSavedAuthState(ctx) && !(await isLoginWallPage(page))) {
      await ensureAuthenticatedLanding(page, ctx);
      const auth = await assertHappyOutcome(page, 'login');
      const s2 = await shot(page, ctx, trace.taskId, 'after');
      if (!auth.ok) {
        emitFinding(ctx, trace, {
          severity: 'high',
          area: 'PRD-Happy',
          title: `Login happy path failed — ${trace.feature.slice(0, 60)}`,
          steps: ['Restore session / login', 'Assert authenticated app'],
          expected: 'Authenticated inventory/app',
          actual: auth.detail,
          evidence: [s1, s2],
          reproRate: '1/1',
          automationCandidate: true,
        });
        reportCoverage(ctx, trace, 'failed', auth.detail, 1);
        return;
      }
      reportCoverage(ctx, trace, 'passed', auth.detail, 0);
      return;
    }

    const creds = ctx.config.credentials;
    if (creds?.username && creds.password) {
      await page
        .locator('#user-name, input[name="user-name"], input[type="text"]')
        .first()
        .fill(creds.username)
        .catch(() => {});
      await page.locator('#password, input[type="password"]').first().fill(creds.password).catch(() => {});
      await clickPrimarySubmit(page);
      await ensureAuthenticatedLanding(page, ctx);
    }
  }

  if (intent === 'logout') {
    const clicked = await openBurgerLogout(page);
    const s2 = await shot(page, ctx, trace.taskId, 'after');
    if (!clicked) {
      emitFinding(ctx, trace, {
        severity: 'medium',
        area: 'PRD-Happy',
        title: `Logout control not found — ${trace.feature.slice(0, 60)}`,
        steps: ['Open menu', 'Click Logout'],
        expected: 'Logout control available',
        actual: 'No logout link/button found',
        evidence: [s1, s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
      reportCoverage(ctx, trace, 'failed', 'Logout control not found', 1);
      return;
    }

    // Do NOT submit the login form — Sauce Demo shows "Username is required" if you do.
    const outcome = await assertLogoutSuccess(page);
    if (!outcome.ok) {
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Happy',
        title: `Logout happy path failed — ${trace.feature.slice(0, 60)}`,
        steps: [
          'Open burger menu',
          'Click Logout',
          'Assert login form',
          'Assert inventory inaccessible',
        ],
        expected: 'Login wall; no authenticated inventory',
        actual: outcome.detail,
        evidence: [s1, s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
      reportCoverage(ctx, trace, 'failed', outcome.detail, 1);
      return;
    }
    reportCoverage(ctx, trace, 'passed', outcome.detail, 0);
    return;
  }

  if (intent === 'add-to-cart') {
    const before = await getCartBadgeCount(page);
    await addFirstProductToCart(page, ctx);
    const after = await getCartBadgeCount(page);
    ctx.onLog(`[PRD] Cart badge ${before} → ${after}`);
  }

  if (intent === 'inventory') {
    const sortNote = await exerciseInventorySort(page);
    ctx.onLog(`[PRD] ${sortNote}`);
  }

  if (intent === 'cart') {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
    const linesBefore = await countCartLineItems(page);
    const totals = await readVisibleTotals(page);
    ctx.onLog(`[PRD] Cart lines=${linesBefore}; totals: ${totals}`);

    // Verify Remove works as a secondary check, then ALWAYS reseed via inventory
    // (do not leave the happy-path assert on an empty cart we just emptied).
    if (linesBefore >= 1) {
      const removed = await removeFirstCartItem(page);
      ctx.onLog(`[PRD] ${removed.detail}`);
      const checkoutOnEmpty = page.locator('[data-test="checkout"], button:has-text("Checkout")').first();
      if (
        (await countCartLineItems(page)) === 0 &&
        (await checkoutOnEmpty.count()) > 0 &&
        (await checkoutOnEmpty.isEnabled().catch(() => false))
      ) {
        emitFinding(ctx, {
          feature: trace.feature,
          variant: 'happy',
          requirementId: trace.requirementId,
          taskId: trace.taskId,
          criteria: trace.criteria,
        }, {
          severity: 'medium',
          area: 'PRD-Happy',
          title: `Checkout enabled on empty cart — ${trace.feature.slice(0, 50)}`,
          steps: ['Open cart', 'Remove all items', 'Observe Checkout button'],
          expected: 'Checkout disabled or hidden when cart is empty',
          actual: `Checkout still enabled with 0 line items at ${page.url()}`,
          evidence: [await shot(page, ctx, trace.taskId, 'empty-checkout-enabled')],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }
      await ensureInventoryWithAddButtons(page, ctx);
      await seedCart(page, ctx, 1);
      await openCart(page, ctx);
    }
  }

  if (intent === 'checkout') {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
    const checkout = page.locator('[data-test="checkout"], button:has-text("Checkout")').first();
    if ((await checkout.count()) > 0) await checkout.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('#first-name, [data-test="firstName"]').first().fill('QA', { timeout: 2000 }).catch(() => {});
    await page.locator('#last-name, [data-test="lastName"]').first().fill('Tester', { timeout: 2000 }).catch(() => {});
    await page.locator('#postal-code, [data-test="postalCode"]').first().fill('560001', { timeout: 2000 }).catch(() => {});
    await page.locator('[data-test="continue"], input[type="submit"]').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
    const overview = await assertCheckoutOverviewGuards(page);
    ctx.onLog(`[PRD] ${overview}`);
    await page.locator('[data-test="finish"], button:has-text("Finish")').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  if (intent === 'inventory' || intent === 'generic') {
    await fillSafePlaceholders(page, ctx);
  }

  const err = !(await isLoginWallPage(page))
    ? await findVisibleErrorText(page, 400)
    : null;

  const s2 = await shot(page, ctx, trace.taskId, 'after');
  const outcome = await assertHappyOutcome(page, intent);

  if (err && intent === 'login') {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Happy',
      title: `Login happy path error — ${trace.feature.slice(0, 60)}`,
      steps: ['Submit valid credentials'],
      expected: 'Authenticated app',
      actual: `Error: ${err.slice(0, 160)}`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
    reportCoverage(ctx, trace, 'failed', `Login error: ${err.slice(0, 100)}`, 1);
    return;
  }

  if (!outcome.ok) {
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Happy',
      title: `Happy path assertion failed — ${trace.feature.slice(0, 60)}`,
      steps: [`Exercise intent=${intent}`, 'Assert verified outcome'],
      expected: 'Feature-specific success criteria',
      actual: outcome.detail + (err ? ` | message: ${err.slice(0, 80)}` : ''),
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
    reportCoverage(ctx, trace, 'failed', outcome.detail, 1);
    return;
  }

  reportCoverage(ctx, trace, 'passed', outcome.detail, 0);
}

async function runNegativePath(
  page: Page,
  ctx: ExecutorContext,
  trace: TraceCtx,
): Promise<void> {
  const intent = featureIntent(trace.feature);
  const s1 = await shot(page, ctx, trace.taskId, 'before');
  let findings = 0;
  const notes: string[] = [];

  if (intent === 'login') {
    if (!(await isLoginWallPage(page))) {
      await openBurgerLogout(page);
      await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    await page.locator('#user-name, input[name="user-name"], input[type="text"]').first().fill('', { timeout: 2000 }).catch(() => {});
    await page.locator('#password, input[type="password"]').first().fill('', { timeout: 2000 }).catch(() => {});
    await clickPrimarySubmit(page);
    const emptyError = await findVisibleErrorText(page, 800);
    if (!emptyError) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Negative',
        title: `No validation on empty login — ${trace.feature.slice(0, 60)}`,
        steps: ['Open login', 'Submit empty credentials'],
        expected: 'Validation error',
        actual: 'No visible validation message',
        evidence: [s1, await shot(page, ctx, trace.taskId, 'empty')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('empty: no validation');
    } else {
      notes.push(`empty: "${emptyError.slice(0, 60)}"`);
    }

    await page
      .locator('#user-name, input[name="user-name"], input[type="text"]')
      .first()
      .fill(ctx.config.credentials?.username ?? 'standard_user')
      .catch(() => {});
    await page.locator('#password, input[type="password"]').first().fill('wrong_password_xyz', { timeout: 2000 }).catch(() => {});
    await clickPrimarySubmit(page);
    const wrongError = await findVisibleErrorText(page, 800);
    if (!(await isLoginWallPage(page))) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'critical',
        area: 'PRD-Negative',
        title: `Wrong password accepted — ${trace.feature.slice(0, 60)}`,
        steps: ['Submit valid user + wrong password'],
        expected: 'Stay on login with validation error',
        actual: `Reached ${page.url()}`,
        evidence: [await shot(page, ctx, trace.taskId, 'wrong-pw')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('wrong-password: ACCEPTED');
    } else if (!wrongError) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Negative',
        title: `No validation on wrong password — ${trace.feature.slice(0, 60)}`,
        steps: ['Submit wrong password'],
        expected: 'Validation error',
        actual: 'Still on login but no message',
        evidence: [await shot(page, ctx, trace.taskId, 'wrong-pw')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('wrong-password: no message');
    } else {
      notes.push(`wrong-password: "${wrongError.slice(0, 60)}"`);
    }

    await page.locator('#user-name, input[name="user-name"], input[type="text"]').first().fill('locked_out_user', { timeout: 2000 }).catch(() => {});
    await page.locator('#password, input[type="password"]').first().fill('secret_sauce', { timeout: 2000 }).catch(() => {});
    await clickPrimarySubmit(page);
    const lockedError = await findVisibleErrorText(page, 800);
    if (lockedError) {
      notes.push(`locked_out_user: "${lockedError.slice(0, 50)}"`);
    } else {
      notes.push('locked_out_user: no known lock message (site may not support)');
    }

    await shot(page, ctx, trace.taskId, 'after');
    reportCoverage(ctx, trace, findings > 0 ? 'failed' : 'passed', notes.join('; '), findings);
    return;
  }

  // Add-to-cart negative: clear item / ensure Remove → Add restores (not full checkout suite)
  if (intent === 'add-to-cart') {
    await ensureAuthenticatedLanding(page, ctx);
    ctx.onLog('[PRD] Negative add-to-cart: clear then re-add');
    const before = await getCartBadgeCount(page);
    await addFirstProductToCart(page, ctx);
    const afterAdd = await getCartBadgeCount(page);
    const remove = page.locator('button:has-text("Remove"), [data-test^="remove"]').first();
    if ((await remove.count()) > 0 && (await remove.isVisible().catch(() => false))) {
      await remove.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const afterRemove = await getCartBadgeCount(page);
    notes.push(`badge before=${before} afterAdd=${afterAdd} afterRemove=${afterRemove}`);
    if (afterAdd < 1) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Negative',
        title: `Could not add item for negative cart check — ${trace.feature.slice(0, 50)}`,
        steps: ['Add to cart', 'Assert badge'],
        expected: 'Badge >= 1 after add',
        actual: `badge=${afterAdd}`,
        evidence: [s1, await shot(page, ctx, trace.taskId, 'after')],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
    await shot(page, ctx, trace.taskId, 'after');
    reportCoverage(ctx, trace, findings > 0 ? 'failed' : 'passed', notes.join('; '), findings);
    return;
  }

  if (intent === 'cart') {
    await ensureAuthenticatedLanding(page, ctx);
    ctx.onLog('[PRD] Negative cart: verify empty-cart state');
    for (let i = 0; i < 6; i++) {
      const remove = page.locator('button:has-text("Remove"), [data-test^="remove"]').first();
      if ((await remove.count()) === 0 || !(await remove.isVisible().catch(() => false))) break;
      await remove.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    await openCart(page, ctx);
    const lines = await countCartLineItems(page);
    const badge = await getCartBadgeCount(page);
    notes.push(`empty cart check lines=${lines} badge=${badge}`);
    await shot(page, ctx, trace.taskId, 'after');
    reportCoverage(ctx, trace, 'passed', notes.join('; '), 0);
    return;
  }

  if (intent === 'checkout') {
    await ensureAuthenticatedLanding(page, ctx);
    ctx.onLog('[PRD] Negative checkout: empty / whitespace / missing postal');

    const openCheckoutStepOne = async () => {
      await seedCart(page, ctx, 1);
      await openCart(page, ctx);
      await page
        .locator('[data-test="checkout"], button:has-text("Checkout")')
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
      await page.waitForTimeout(300);
      // Always land on step-one form fields
      if (!(await page.locator('#first-name, [data-test="firstName"]').first().isVisible().catch(() => false))) {
        const origin = new URL(ctx.config.targetUrl).origin;
        await page
          .goto(`${origin}/checkout-step-one.html`, { waitUntil: 'domcontentloaded', timeout: 15000 })
          .catch(() => {});
      }
    };

    const fillCheckout = async (first: string, last: string, postal: string) => {
      const opts = { timeout: 3000 };
      await page.locator('#first-name, [data-test="firstName"]').first().fill(first, opts).catch(() => {});
      await page.locator('#last-name, [data-test="lastName"]').first().fill(last, opts).catch(() => {});
      await page.locator('#postal-code, [data-test="postalCode"]').first().fill(postal, opts).catch(() => {});
      await page.locator('[data-test="continue"]').first().click(opts).catch(() => {});
    };

    // Empty cart → should not reach complete
    for (let i = 0; i < 6; i++) {
      const remove = page.locator('button:has-text("Remove"), [data-test^="remove"]').first();
      if ((await remove.count()) === 0 || !(await remove.isVisible().catch(() => false))) break;
      await remove.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    await openCart(page, ctx);
    const lines = await countCartLineItems(page);
    if (lines === 0) {
      await page
        .locator('[data-test="checkout"], button:has-text("Checkout")')
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
      await page.waitForTimeout(400);
      if (isCheckoutCompleteUrl(page.url())) {
        findings++;
        emitFinding(ctx, trace, {
          severity: 'high',
          area: 'PRD-Negative',
          title: `Empty cart reached checkout complete — ${trace.feature.slice(0, 60)}`,
          steps: ['Clear cart', 'Checkout'],
          expected: 'Checkout blocked or cannot complete without items',
          actual: `Reached ${page.url()}`,
          evidence: [s1, await shot(page, ctx, trace.taskId, 'empty-cart')],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        notes.push(`empty-cart checkout stayed at ${page.url()} (not complete)`);
      }
    }

    await openCheckoutStepOne();
    await fillCheckout('   ', '   ', '560001');
    const wsErr = await findVisibleErrorText(page, 500);
    if (wsErr) {
      notes.push(`whitespace names: "${wsErr.slice(0, 50)}"`);
    } else if (/step-two|overview/i.test(page.url())) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'medium',
        area: 'PRD-Negative',
        title: `Whitespace names accepted at checkout — ${trace.feature.slice(0, 50)}`,
        steps: ['Fill whitespace first/last name', 'Continue'],
        expected: 'Validation error',
        actual: `Advanced to ${page.url()}`,
        evidence: [await shot(page, ctx, trace.taskId, 'whitespace')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('whitespace names accepted');
    } else {
      notes.push('whitespace names: stayed on step-one or blocked');
    }

    await openCheckoutStepOne();
    await fillCheckout('QA', 'Tester', '');
    const postalErr = await findVisibleErrorText(page, 500);
    if (!postalErr && /step-two|overview/i.test(page.url())) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Negative',
        title: `Missing postal accepted — ${trace.feature.slice(0, 60)}`,
        steps: ['Fill name only', 'Continue without postal'],
        expected: 'Postal required validation',
        actual: `Advanced to ${page.url()}`,
        evidence: [await shot(page, ctx, trace.taskId, 'no-postal')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('postal missing: accepted');
    } else {
      notes.push(`postal missing: "${(postalErr ?? 'blocked').slice(0, 50)}"`);
    }

    await openCheckoutStepOne();
    await fillCheckout('', '', '');
    const emptyCheckout = await findVisibleErrorText(page, 500);
    if (!emptyCheckout) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Negative',
        title: `No validation on empty checkout — ${trace.feature.slice(0, 60)}`,
        steps: ['Checkout with all fields empty'],
        expected: 'Validation error',
        actual: 'No visible validation',
        evidence: [await shot(page, ctx, trace.taskId, 'empty-checkout')],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      notes.push(`empty checkout: "${emptyCheckout.slice(0, 50)}"`);
    }

    await shot(page, ctx, trace.taskId, 'after');
    reportCoverage(
      ctx,
      trace,
      findings > 0 ? 'failed' : 'passed',
      notes.join('; ') || 'Negative checkout checks completed',
      findings,
    );
    return;
  }

  if (intent === 'logout') {
    await openBurgerLogout(page);
    await page
      .goto(`${new URL(ctx.config.targetUrl).origin}/inventory.html`, {
        waitUntil: 'domcontentloaded',
      })
      .catch(() => {});
    await page.waitForTimeout(400);
    const stillAuth = !(await isLoginWallPage(page)) && (await countInventoryItems(page)) > 0;
    const s2 = await shot(page, ctx, trace.taskId, 'after');
    if (stillAuth) {
      emitFinding(ctx, trace, {
        severity: 'critical',
        area: 'PRD-Negative',
        title: `Inventory accessible after logout — ${trace.feature.slice(0, 60)}`,
        steps: ['Logout', 'Navigate to /inventory.html'],
        expected: 'Login wall or no product access',
        actual: `Still authenticated at ${page.url()}`,
        evidence: [s1, s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
      reportCoverage(ctx, trace, 'failed', 'Inventory still accessible after logout', 1);
      return;
    }
    reportCoverage(
      ctx,
      trace,
      'passed',
      `Post-logout inventory blocked (loginWall=${await isLoginWallPage(page)})`,
      0,
    );
    return;
  }

  if (intent === 'inventory') {
    const origin = new URL(ctx.config.targetUrl).origin;
    await page
      .goto(`${origin}/inventory-item.html?id=99999`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await page.waitForTimeout(400);
    const healthy = await pageLooksHealthy(page);
    await shot(page, ctx, trace.taskId, 'after');
    notes.push(`invalid product id page healthy=${healthy} url=${page.url()}`);
    reportCoverage(ctx, trace, 'passed', notes.join('; '), 0);
    return;
  }

  const submittedEmpty = await clickPrimarySubmit(page);
  const emptyError = await findVisibleErrorText(page, 800);
  const inputs = page.locator(
    'input[type="text"]:visible, input:not([type]):visible, textarea:visible',
  );
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 3); i++) {
    await inputs.nth(i).fill('<script>alert(1)</script>', { timeout: 2000 }).catch(() => {});
  }
  if (count > 0) await clickPrimarySubmit(page);
  const invalidError = await findVisibleErrorText(page, 500);
  const s2 = await shot(page, ctx, trace.taskId, 'after');

  if (submittedEmpty && !emptyError && count > 0) {
    findings++;
    emitFinding(ctx, trace, {
      severity: 'medium',
      area: 'PRD-Negative',
      title: `Weak/empty validation — ${trace.feature.slice(0, 60)}`,
      steps: [`Open feature: ${trace.feature}`, 'Submit empty/invalid input'],
      expected: 'Validation feedback',
      actual: 'No visible validation message',
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  reportCoverage(
    ctx,
    trace,
    findings > 0 ? 'failed' : 'passed',
    findings > 0
      ? `${findings} negative-case issue(s)`
      : emptyError || invalidError
        ? `Validation present: "${(emptyError ?? invalidError ?? '').slice(0, 80)}"`
        : 'Negative checks completed',
    findings,
  );
}

async function runInterruptionPath(
  page: Page,
  ctx: ExecutorContext,
  trace: TraceCtx,
): Promise<void> {
  const intent = featureIntent(trace.feature);
  const s1 = await shot(page, ctx, trace.taskId, 'before');
  let findings = 0;
  const notes: string[] = [];

  if (intent === 'checkout') {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
    await page.locator('[data-test="checkout"], button:has-text("Checkout")').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('#first-name, [data-test="firstName"]').first().fill('Interrupt', { timeout: 2000 }).catch(() => {});
    await page.locator('#last-name, [data-test="lastName"]').first().fill('Test', { timeout: 2000 }).catch(() => {});
    await page.locator('#postal-code, [data-test="postalCode"]').first().fill('560001', { timeout: 2000 }).catch(() => {});
  } else if (intent === 'login') {
    await page.goto(ctx.config.targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.locator('#user-name, input[name="user-name"]').first().fill('standard_user', { timeout: 2000 }).catch(() => {});
  } else if (intent === 'cart' || intent === 'add-to-cart') {
    await seedCart(page, ctx, 1);
    if (intent === 'cart') await openCart(page, ctx);
  } else if (intent === 'logout') {
    const burger = page.locator('#react-burger-menu-btn').first();
    if ((await burger.count()) > 0) await burger.click({ timeout: 2000 }).catch(() => {});
  } else {
    await fillSafePlaceholders(page, ctx);
  }

  const urlBefore = page.url();
  const firstBefore = await getInputValue(page, '#first-name, [data-test="firstName"]');

  // Seed real history so goBack is meaningful (avoids about:blank harness FPs)
  const priorUrl = resolveExplorationStartUrl(ctx);
  await seedHistoryForBack(page, urlBefore, priorUrl);
  // Re-apply feature setup after history seeding when needed
  if (intent === 'checkout' && !isCheckoutStepUrl(page.url())) {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
    await page.locator('[data-test="checkout"], button:has-text("Checkout")').first().click({ timeout: 3000 }).catch(() => {});
    await page.locator('#first-name, [data-test="firstName"]').first().fill('Interrupt', { timeout: 3000 }).catch(() => {});
  } else if (intent === 'cart' && !isCartUrl(page.url())) {
    await seedCart(page, ctx, 1);
    await openCart(page, ctx);
  }

  const urlReady = page.url();
  await page.goBack({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  let afterBack = page.url();

  if (isHarnessBlankUrl(afterBack)) {
    notes.push('back: about:blank/empty history — harness skip (not an app defect)');
    ctx.onLog('[PRD] goBack hit blank URL — recovering to feature URL (no HIGH finding)');
    await page.goto(urlReady || urlBefore, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    afterBack = page.url();
  } else {
    const healthyAfterBack = await pageLooksHealthy(page);
    if (!healthyAfterBack) {
      findings++;
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD-Interruption',
        title: `Broken page after Back — ${trace.feature.slice(0, 60)}`,
        steps: [`On ${urlReady}`, 'Browser Back'],
        expected: 'Healthy recovery page',
        actual: `Unhealthy at ${page.url()}`,
        evidence: [s1, await shot(page, ctx, trace.taskId, 'after-back')],
        reproRate: '1/1',
        automationCandidate: true,
      });
      notes.push('back: unhealthy page');
    } else {
      notes.push(`back: ${urlReady} → ${afterBack}`);
    }
  }

  await page.goto(urlReady || urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (intent === 'checkout') {
    await page.locator('#first-name, [data-test="firstName"]').first().fill('Interrupt', { timeout: 3000 }).catch(() => {});
    await page.locator('#last-name, [data-test="lastName"]').first().fill('Test', { timeout: 3000 }).catch(() => {});
    await page.locator('#postal-code, [data-test="postalCode"]').first().fill('560001', { timeout: 3000 }).catch(() => {});
    const continueBtn = page.locator('[data-test="continue"]').first();
    if ((await continueBtn.count()) > 0) {
      await Promise.all([
        continueBtn.click({ timeout: 3000 }).catch(() => {}),
        page.waitForTimeout(80).then(() => page.reload().catch(() => {})),
      ]);
    } else {
      await page.reload().catch(() => {});
    }
  } else {
    await page.reload().catch(() => {});
  }
  await page.waitForTimeout(500);

  if (isHarnessBlankUrl(page.url())) {
    await page.goto(urlReady || urlBefore, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }

  const healthyAfterRefresh = await pageLooksHealthy(page);
  const firstAfter = await getInputValue(page, '#first-name, [data-test="firstName"]');

  if (!healthyAfterRefresh) {
    findings++;
    emitFinding(ctx, trace, {
      severity: 'high',
      area: 'PRD-Interruption',
      title: `Broken page after Refresh — ${trace.feature.slice(0, 60)}`,
      steps: ['Mid-flow refresh'],
      expected: 'Page recovers without crash',
      actual: `Unhealthy at ${page.url()}`,
      evidence: [await shot(page, ctx, trace.taskId, 'after-refresh')],
      reproRate: '1/1',
      automationCandidate: true,
    });
    notes.push('refresh: unhealthy');
  } else if (intent === 'checkout') {
    const retained = firstAfter === 'Interrupt' || firstAfter === firstBefore;
    notes.push(
      retained
        ? `refresh: checkout field retained ("${firstAfter}")`
        : `refresh: checkout fields cleared (documented), first="${firstAfter}"`,
    );
  } else {
    notes.push(`refresh: healthy at ${page.url()}`);
  }

  const s2 = await shot(page, ctx, trace.taskId, 'after');

  if (findings > 0) {
    reportCoverage(ctx, trace, 'failed', notes.join('; '), findings);
    return;
  }

  emitFinding(ctx, trace, {
    severity: 'info',
    area: 'PRD-Interruption',
    title: `Interruption criteria met — ${trace.feature.slice(0, 60)}`,
    steps: ['Back navigation', 'Refresh mid-flow', 'Assert healthy recovery'],
    expected: 'No crash; clear recovery (fields retained or cleared is documented)',
    actual: notes.join('; '),
    evidence: [s1, s2],
    reproRate: '1/1',
    automationCandidate: true,
  });

  reportCoverage(ctx, trace, 'passed', notes.join('; '), 0);
}

export async function runPrdDrivenFlow(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  const feature = task.meta?.prdFeature ?? task.description ?? task.title;
  const variant: PrdTestVariant = task.meta?.prdVariant ?? 'happy';
  const trace: TraceCtx = {
    feature,
    variant,
    requirementId: task.meta?.prdRequirementId,
    taskId: task.id,
    criteria: task.meta?.prdCriteria,
  };

  ctx.onLog(
    `[PRD] [${trace.requirementId ?? '—'}] ${variant.toUpperCase()} — ${feature.slice(0, 100)}`,
  );

  if (task.meta?.isAuthSmoke) {
    await runAuthSmokeGate(page, ctx, trace);
    return;
  }

  const loginFeature = isLoginRelatedFeature(feature);

  if (!loginFeature) {
    const ok = await ensureAuthenticatedLanding(page, ctx);
    if (!ok && (await isLoginWallPage(page))) {
      await page
        .goto(resolveExplorationStartUrl(ctx), { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      await ensureAuthenticatedLanding(page, ctx);
    }

    if (await isLoginWallPage(page)) {
      reportCoverage(
        ctx,
        trace,
        'blocked',
        'Login wall present after session restore — cannot exercise PRD feature UI',
        1,
      );
      emitFinding(ctx, trace, {
        severity: 'high',
        area: 'PRD',
        title: `Blocked by login wall — ${feature.slice(0, 70)}`,
        steps: [`Test PRD feature: ${feature}`, 'Restore auth-state and open post-login URL'],
        expected: 'Authenticated access to feature UI',
        actual: 'Still on login/OTP wall',
        evidence: [await shot(page, ctx, task.id, 'blocked')],
        reproRate: '1/1',
        automationCandidate: false,
      });
      return;
    }
  }

  const found = await locateFeatureUi(page, ctx, feature);
  if (!found) {
    reportCoverage(ctx, trace, 'gap', 'No matching UI for this PRD feature', 1);
    emitFinding(ctx, trace, {
      severity: 'medium',
      area: 'PRD-Gap',
      title: `PRD gap — UI not found for: ${feature.slice(0, 70)}`,
      steps: [`Parse PRD feature: ${feature}`, 'Locate nav/buttons / domain intents'],
      expected: 'Feature reachable in the application UI',
      actual: 'No matching UI found — coverage gap',
      evidence: [await shot(page, ctx, task.id, 'gap')],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  if (variant === 'negative') {
    await runNegativePath(page, ctx, trace);
    return;
  }
  if (variant === 'interruption') {
    await runInterruptionPath(page, ctx, trace);
    return;
  }
  await runHappyPath(page, ctx, trace);
}
