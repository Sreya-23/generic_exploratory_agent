import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask, SiteType } from '@qa/shared';
import { fillExtras } from './user-directed.js';

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `journey-${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

// ── Ecommerce ─────────────────────────────────────────────────────────────────

async function runEcommerceJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/ecommerce] Browse catalog → product → cart → checkout');

  // 1. Find and click a product link
  const productLink = page.locator(
    'a[href*="product"], a[href*="item"], a[href*="shop"], .product a, [data-testid*="product"] a',
  ).first();

  if (await productLink.count() > 0) {
    await productLink.click();
    await page.waitForLoadState('domcontentloaded');
    ctx.onLog('[Journey/ecommerce] Opened product page');
    await shot(page, ctx, 'product-detail');
  } else {
    ctx.onLog('[Journey/ecommerce] No product link found, continuing from landing');
  }

  // 2. Add to cart
  const addToCart = page.locator(
    'button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("Buy Now"), [data-testid*="add-to-cart"]',
  ).first();

  if (await addToCart.count() > 0) {
    const cartBefore = await page.locator('[class*="cart-count"], [data-testid*="cart"] span, .cart-badge').first().textContent().catch(() => '0');
    await addToCart.click();
    await page.waitForTimeout(800);
    const cartAfter = await page.locator('[class*="cart-count"], [data-testid*="cart"] span, .cart-badge').first().textContent().catch(() => null);
    const s = await shot(page, ctx, 'after-add-to-cart');

    if (cartAfter !== null && cartBefore !== cartAfter) {
      ctx.onLog(`[Journey/ecommerce] Cart count updated: ${cartBefore} → ${cartAfter}`);
    } else if (cartAfter === cartBefore) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Journey',
        title: 'Cart count did not update after "Add to Cart"',
        steps: ['Open product page', 'Click "Add to Cart"', 'Observe cart badge'],
        expected: 'Cart count increments',
        actual: 'Cart badge unchanged',
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
  } else {
    ctx.onLog('[Journey/ecommerce] No "Add to Cart" button found');
  }

  // 3. Navigate to cart
  const cartLink = page.locator(
    'a[href*="cart"], a[href*="basket"], [aria-label*="cart" i], [data-testid*="cart"]',
  ).first();

  if (await cartLink.count() > 0) {
    await cartLink.click();
    await page.waitForLoadState('domcontentloaded');
    await shot(page, ctx, 'cart-page');
    ctx.onLog('[Journey/ecommerce] Opened cart page');

    // 4. Proceed to checkout
    const checkoutBtn = page.locator(
      'button:has-text("Checkout"), a:has-text("Checkout"), button:has-text("Proceed"), a[href*="checkout"]',
    ).first();

    if (await checkoutBtn.count() > 0) {
      await checkoutBtn.click();
      await page.waitForLoadState('domcontentloaded');
      const s = await shot(page, ctx, 'checkout-page');
      ctx.onLog('[Journey/ecommerce] Reached checkout page');

      const onCheckout =
        page.url().includes('checkout') ||
        (await page.locator('form').count()) > 0;

      if (!onCheckout) {
        ctx.onFinding({
          severity: 'high',
          area: 'UI-Journey',
          title: 'Checkout button did not navigate to checkout form',
          steps: ['Add item to cart', 'Open cart', 'Click Checkout'],
          expected: 'Checkout form shown',
          actual: `Landed on: ${page.url()}`,
          evidence: [s],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }
    }
  }
}

// ── Booking ───────────────────────────────────────────────────────────────────

async function runBookingJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/booking] Search → select → confirm');

  // Pre-fill any extras the user provided (phone, guest name, etc.)
  const extras = ctx.config.credentials?.extras;
  if (extras) await fillExtras(page, extras);

  const dateInput = page.locator('input[type="date"], input[placeholder*="date" i], input[placeholder*="check" i]').first();
  const s1 = await shot(page, ctx, 'booking-landing');

  if (await dateInput.count() > 0) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const checkout = new Date(tomorrow);
    checkout.setDate(checkout.getDate() + 2);

    const fmt = (d: Date) => d.toISOString().split('T')[0];
    await dateInput.fill(fmt(tomorrow)).catch(() => {});

    const checkoutInput = page.locator('input[type="date"]').nth(1);
    if (await checkoutInput.count() > 0) {
      await checkoutInput.fill(fmt(checkout)).catch(() => {});
    }

    ctx.onLog(`[Journey/booking] Filled dates: ${fmt(tomorrow)} – ${fmt(checkout)}`);

    const searchBtn = page.locator(
      'button:has-text("Search"), button:has-text("Check Availability"), button:has-text("Find"), button[type="submit"]',
    ).first();

    if (await searchBtn.count() > 0) {
      await searchBtn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await shot(page, ctx, 'booking-results');
      ctx.onLog('[Journey/booking] Search submitted');
    }
  } else {
    ctx.onFinding({
      severity: 'info',
      area: 'UI-Journey',
      title: 'No date input found for booking search',
      steps: ['Navigate to booking site', 'Look for date picker'],
      expected: 'Date input for availability search',
      actual: 'No date inputs found on landing page',
      evidence: [s1],
      reproRate: '1/1',
      automationCandidate: false,
    });
  }
}

// ── Auth Portal ───────────────────────────────────────────────────────────────

async function runAuthPortalJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  const config = ctx.config;
  ctx.onLog('[Journey/auth-portal] Login valid → home → login invalid → error → logout');

  // 1. Test invalid credentials first (non-destructive)
  const usernameInput = page.locator('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first();

  if (await usernameInput.count() === 0 || await passwordInput.count() === 0) {
    ctx.onLog('[Journey/auth-portal] Login form inputs not found');
    return;
  }

  // Invalid login test
  await usernameInput.fill('invalid_user_qa_test');
  await passwordInput.fill('wrongpassword123');
  await submitBtn.click();
  await page.waitForTimeout(1000);

  const errorMsg = await page.locator(
    '[class*="error"], [role="alert"], [class*="invalid"], [data-test*="error"]',
  ).first().textContent().catch(() => null);

  const s1 = await shot(page, ctx, 'auth-invalid-login');

  if (!errorMsg) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Journey',
      title: 'No error message shown for invalid login credentials',
      steps: ['Enter invalid username and password', 'Click Login'],
      expected: 'Clear error message displayed',
      actual: 'No visible error feedback',
      evidence: [s1],
      reproRate: '1/1',
      automationCandidate: true,
    });
  } else {
    ctx.onLog(`[Journey/auth-portal] Invalid login correctly shows error: "${errorMsg.trim().slice(0, 80)}"`);
  }

  // Pre-fill extras into any currently visible fields (e.g. custom login fields)
  const extras = config.credentials?.extras;
  if (extras) await fillExtras(page, extras);

  // Valid login test (only if credentials provided)
  const creds = config.credentials;
  if (!creds || creds.type === 'none' || !creds.username || !creds.password) {
    ctx.onLog('[Journey/auth-portal] No valid credentials provided — skipping valid login test');
    return;
  }

  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
  const usernameInput2 = page.locator('input[type="text"], input[type="email"], input[name*="user" i]').first();
  const passwordInput2 = page.locator('input[type="password"]').first();
  const submitBtn2 = page.locator('button[type="submit"], input[type="submit"]').first();

  await usernameInput2.fill(creds.username);
  await passwordInput2.fill(creds.password);
  await submitBtn2.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);

  const s2 = await shot(page, ctx, 'auth-valid-login');
  const stillOnLogin = (await page.locator('input[type="password"]').count()) > 0;

  if (stillOnLogin) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Journey',
      title: 'Valid credentials did not complete login',
      steps: [`Enter username: ${creds.username}`, 'Enter password', 'Click Login'],
      expected: 'Navigate to authenticated home page',
      actual: 'Still on login page',
      evidence: [s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
    return;
  }

  ctx.onLog('[Journey/auth-portal] Valid login succeeded');

  // Logout test
  const logoutLink = page.locator(
    'a:has-text("Logout"), a:has-text("Log out"), button:has-text("Logout"), #logout_sidebar_link, [data-test="logout"]',
  ).first();

  if (await logoutLink.count() > 0) {
    await logoutLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(800);
    const s3 = await shot(page, ctx, 'auth-after-logout');

    const backOnLogin = (await page.locator('input[type="password"]').count()) > 0;
    if (!backOnLogin) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Journey',
        title: 'Logout does not redirect to login page',
        steps: ['Login with valid credentials', 'Click Logout'],
        expected: 'Redirected to login page',
        actual: `Landed on: ${page.url()}`,
        evidence: [s3],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[Journey/auth-portal] Logout correctly returns to login page');
    }
  }
}

// ── SaaS Dashboard ────────────────────────────────────────────────────────────

async function runSaasDashboardJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/saas] List entities → create → edit → delete');

  await shot(page, ctx, 'saas-dashboard');

  // Try to find a "Create" or "New" button
  const createBtn = page.locator(
    'button:has-text("New"), button:has-text("Create"), button:has-text("Add"), a:has-text("New")',
  ).first();

  if (await createBtn.count() > 0) {
    await createBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, ctx, 'saas-create-form');
    ctx.onLog('[Journey/saas] Create form / modal opened');

    // Check if a form appeared
    const formAppeared = (await page.locator('form, [role="dialog"]').count()) > 0;
    if (!formAppeared) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Journey',
        title: 'Create button did not open a form or modal',
        steps: ['Navigate to dashboard', 'Click Create/New button'],
        expected: 'Form or modal for creating entity appears',
        actual: 'No form or dialog visible',
        evidence: [await shot(page, ctx, 'saas-create-no-form')],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
  } else {
    ctx.onLog('[Journey/saas] No Create/New button found on dashboard');
  }
}

// ── Blog/CMS ──────────────────────────────────────────────────────────────────

async function runBlogJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/blog] Browse articles → open post → search');

  const articleLink = page.locator(
    'article a, .post a, .entry a, a[href*="/post"], a[href*="/article"], a[href*="/blog/"]',
  ).first();

  if (await articleLink.count() > 0) {
    const href = await articleLink.getAttribute('href');
    await articleLink.click();
    await page.waitForLoadState('domcontentloaded');
    await shot(page, ctx, 'blog-article');
    ctx.onLog(`[Journey/blog] Opened article: ${href}`);

    // Check if article content is rendered
    const hasContent = (await page.locator('article, .post-content, .entry-content, main').count()) > 0;
    if (!hasContent) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Journey',
        title: 'Article page has no identifiable content container',
        steps: ['Click article link from listing', 'Observe article page'],
        expected: 'Article content rendered in semantic container',
        actual: 'No <article>, .post-content, or <main> found',
        evidence: [await shot(page, ctx, 'blog-no-content')],
        reproRate: '1/1',
        automationCandidate: false,
      });
    }
  }

  // Search test
  const searchInput = page.locator('input[type="search"], input[name="q"], input[placeholder*="search" i]').first();
  if (await searchInput.count() > 0) {
    await searchInput.fill('test');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await shot(page, ctx, 'blog-search-results');
    ctx.onLog('[Journey/blog] Search tested');
  }
}

// ── Generic fallback ──────────────────────────────────────────────────────────

async function runGenericJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/generic] No site type identified — running navigation probe');
  const links = await page.$$eval('a[href]', (els) =>
    els
      .map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLAnchorElement).innerText.trim() }))
      .filter((l) => l.href.startsWith('http') && l.text.length > 0 && !l.href.includes('#'))
      .slice(0, 3),
  );

  for (const link of links) {
    await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    ctx.onLog(`[Journey/generic] Visited: ${link.text} → ${page.url()}`);
    await shot(page, ctx, `generic-${link.text.slice(0, 15).replace(/\W/g, '-')}`);
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const JOURNEY_MAP: Record<SiteType, (page: Page, ctx: ExecutorContext) => Promise<void>> = {
  ecommerce: runEcommerceJourney,
  booking: runBookingJourney,
  'auth-portal': runAuthPortalJourney,
  'saas-dashboard': runSaasDashboardJourney,
  'blog-cms': runBlogJourney,
  social: runGenericJourney,
  fintech: runGenericJourney,
  generic: runGenericJourney,
};

export async function runJourneyFlow(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const siteType = ctx.classification?.siteType ?? 'generic';
  const confidence = ctx.classification?.confidence ?? 0;

  ctx.onLog(
    `[Journey] Site type: ${siteType} (confidence: ${Math.round(confidence * 100)}%) — signals: ${ctx.classification?.signals.slice(0, 2).join(', ') ?? 'none'}`,
  );

  const runner = JOURNEY_MAP[siteType] ?? runGenericJourney;
  await runner(page, ctx);
}
