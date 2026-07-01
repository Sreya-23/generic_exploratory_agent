import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask, SiteType } from '@qa/shared';
import { fillExtras } from './user-directed.js';
import { findVisibleErrorText } from './helpers.js';

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `journey-${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/**
 * Semantic button/link finder — works across languages, frameworks, and custom UI kits.
 *
 * Strategy (tries each in order, returns first visible match):
 * 1. data-testid / data-test attributes (most reliable)
 * 2. aria-label attributes (accessible labels, language-independent)
 * 3. Text keywords (English first, then common translations)
 * 4. Class-name patterns (e.g. btn-cart, buy-button)
 * 5. DOM position heuristic (most prominent button in a product card)
 */
async function findSemanticButton(
  page: Page,
  intent: 'add-to-cart' | 'view-cart' | 'checkout' | 'confirm' | 'submit-form' |
          'book-now' | 'search' | 'next-step' | 'login' | 'logout',
): Promise<import('playwright').Locator | null> {
  const strategies: string[][] = [];

  switch (intent) {
    case 'add-to-cart':
      strategies.push(
        ['[data-testid*="add-to-cart"]', '[data-test*="add-to-cart"]', '[data-action*="add-to-cart"]'],
        ['[aria-label*="add to cart" i]', '[aria-label*="add to bag" i]', '[aria-label*="add to basket" i]'],
        [
          'button:has-text("Add to cart")', 'button:has-text("Add to Cart")',
          'button:has-text("Add to bag")', 'button:has-text("Add to Bag")',
          'button:has-text("Add to basket")', 'button:has-text("Buy Now")',
          'button:has-text("Buy now")', 'button:has-text("Add")',
          // Common translations
          'button:has-text("Ajouter au panier")',  // French
          'button:has-text("In den Warenkorb")',    // German
          'button:has-text("Añadir al carrito")',   // Spanish
          'button:has-text("Aggiungi al carrello")', // Italian
        ],
        ['[class*="add-to-cart"]', '[class*="addtocart"]', '[class*="btn-cart"]', '[class*="buy-btn"]'],
      );
      break;

    case 'view-cart':
      strategies.push(
        ['[data-testid*="cart"]', '[data-test*="cart"]'],
        ['[aria-label*="cart" i]', '[aria-label*="basket" i]', '[aria-label*="bag" i]'],
        [
          'a[href*="/cart"]', 'a[href*="/basket"]', 'a[href*="/bag"]',
          'a:has-text("Cart")', 'a:has-text("Basket")', 'a:has-text("View cart")',
          'button:has-text("View cart")', 'button:has-text("Go to cart")',
        ],
        ['[class*="cart-icon"]', '[class*="cart-link"]', '[class*="shopping-bag"]'],
      );
      break;

    case 'checkout':
      strategies.push(
        ['[data-testid*="checkout"]', '[data-test*="checkout"]'],
        ['[aria-label*="checkout" i]', '[aria-label*="proceed" i]'],
        [
          'button:has-text("Checkout")', 'button:has-text("Check out")',
          'button:has-text("Proceed to checkout")', 'button:has-text("Continue to checkout")',
          'a:has-text("Checkout")', 'a[href*="checkout"]',
          'button:has-text("Passer la commande")',  // French
          'button:has-text("Zur Kasse")',            // German
          'button:has-text("Pagar")',                // Spanish
        ],
        ['[class*="checkout-btn"]', '[class*="proceed-btn"]'],
      );
      break;

    case 'book-now':
      strategies.push(
        ['[data-testid*="book"]', '[data-testid*="reserve"]'],
        ['[aria-label*="book" i]', '[aria-label*="reserve" i]', '[aria-label*="check availability" i]'],
        [
          'button:has-text("Book now")', 'button:has-text("Book Now")',
          'button:has-text("Reserve")', 'button:has-text("Check availability")',
          'button:has-text("Search")', 'button:has-text("Find")',
          'button:has-text("Get started")', 'input[type="submit"]',
        ],
        ['[class*="book-btn"]', '[class*="reserve-btn"]', '[class*="cta"]'],
      );
      break;

    case 'confirm':
      strategies.push(
        ['[data-testid*="confirm"]', '[data-testid*="submit"]'],
        ['[aria-label*="confirm" i]', '[aria-label*="place order" i]'],
        [
          'button:has-text("Confirm")', 'button:has-text("Place order")',
          'button:has-text("Complete")', 'button:has-text("Finish")',
          'button:has-text("Submit")', 'button[type="submit"]',
        ],
        ['[class*="confirm-btn"]', '[class*="submit-btn"]'],
      );
      break;

    case 'search':
      strategies.push(
        ['[data-testid*="search"]', 'input[type="search"]'],
        ['[aria-label*="search" i]', '[placeholder*="search" i]'],
        ['button:has-text("Search")', 'button[type="submit"]:near(input[type="search"])'],
        ['[class*="search-btn"]', '[class*="search-button"]'],
      );
      break;

    case 'next-step':
      strategies.push(
        ['[data-testid*="next"]', '[data-testid*="continue"]'],
        ['[aria-label*="next" i]', '[aria-label*="continue" i]'],
        ['button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Proceed")'],
        ['[class*="next-btn"]', '[class*="continue-btn"]'],
      );
      break;

    case 'login':
      strategies.push(
        ['[data-testid*="login"]', '[data-testid*="signin"]'],
        ['[aria-label*="login" i]', '[aria-label*="sign in" i]'],
        [
          'button:has-text("Login")', 'button:has-text("Log in")',
          'button:has-text("Sign in")', 'input[type="submit"][value*="Login" i]',
          'button[type="submit"]',
        ],
        ['[class*="login-btn"]', '[class*="signin-btn"]'],
      );
      break;

    case 'logout':
      strategies.push(
        ['[data-testid*="logout"]', '[data-testid*="signout"]'],
        ['[aria-label*="logout" i]', '[aria-label*="sign out" i]'],
        [
          'a:has-text("Logout")', 'a:has-text("Log out")', 'a:has-text("Sign out")',
          'button:has-text("Logout")', 'button:has-text("Sign out")',
          '[href*="logout"]', '[href*="signout"]',
        ],
        ['[class*="logout"]', '[class*="signout"]'],
      );
      break;

    case 'submit-form':
      strategies.push(
        ['button[type="submit"]', 'input[type="submit"]'],
        ['[aria-label*="submit" i]'],
        ['button:has-text("Submit")', 'button:has-text("Save")', 'button:has-text("Send")'],
        ['[class*="submit-btn"]', '[class*="form-submit"]'],
      );
      break;
  }

  // Try each strategy group in order
  for (const group of strategies) {
    for (const sel of group) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && await loc.isVisible().catch(() => false)) {
          return loc;
        }
      } catch {
        // invalid selector, try next
      }
    }
  }

  return null;
}

// ── Ecommerce ─────────────────────────────────────────────────────────────────

async function runEcommerceJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/ecommerce] Browse catalog → product → cart → checkout');

  // 1. Find and click a product — try product links, or any prominent card link
  const productLink = page.locator(
    '[data-testid*="product"] a, .product a, [class*="product-item"] a, ' +
    '[class*="product-card"] a, [class*="item-card"] a, ' +
    'a[href*="product"], a[href*="item"], a[href*="inventory"]',
  ).first();

  if (await productLink.count() > 0 && await productLink.isVisible().catch(() => false)) {
    await productLink.click();
    await page.waitForLoadState('domcontentloaded');
    ctx.onLog('[Journey/ecommerce] Opened product page');
    await shot(page, ctx, 'product-detail');
  } else {
    ctx.onLog('[Journey/ecommerce] No product link found, attempting Add to Cart from current page');
  }

  // 2. Add to cart — semantic discovery (works across languages & frameworks)
  const addToCart = await findSemanticButton(page, 'add-to-cart');

  if (addToCart) {
    const btnLabel = (await addToCart.textContent().catch(() => ''))?.trim() || 'Add to cart';
    const cartBefore = await page
      .locator('[class*="cart-count"], [class*="cart_badge"], .shopping_cart_badge, [data-testid*="cart"] span')
      .first().textContent().catch(() => '0');
    await addToCart.click();
    await page.waitForTimeout(800);
    const cartAfter = await page
      .locator('[class*="cart-count"], [class*="cart_badge"], .shopping_cart_badge, [data-testid*="cart"] span')
      .first().textContent().catch(() => null);
    const s = await shot(page, ctx, 'after-add-to-cart');

    ctx.onLog(`[Journey/ecommerce] Clicked "${btnLabel}" — cart: ${cartBefore} → ${cartAfter ?? 'unknown'}`);

    if (cartAfter !== null && cartBefore === cartAfter) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Journey',
        title: `Cart badge did not update after clicking "${btnLabel}"`,
        steps: ['Open product page', `Click "${btnLabel}"`, 'Observe cart badge'],
        expected: 'Cart count increments',
        actual: 'Cart badge unchanged after click',
        evidence: [s],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }
  } else {
    ctx.onLog('[Journey/ecommerce] No add-to-cart button found on this page');
  }

  // 3. Navigate to cart — semantic discovery
  const cartLink = await findSemanticButton(page, 'view-cart');

  if (cartLink) {
    await cartLink.click();
    await page.waitForLoadState('domcontentloaded');
    await shot(page, ctx, 'cart-page');
    ctx.onLog('[Journey/ecommerce] Opened cart page');

    // 4. Proceed to checkout — semantic discovery
    const checkoutBtn = await findSemanticButton(page, 'checkout');

    if (checkoutBtn) {
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
        return;
      }

      // 5. Pre-action gate before payment — need card/address details
      const extras = ctx.onPreActionNeeded?.({
        type: 'purchase',
        description: 'Complete checkout / payment',
        requiredExtras: ['card'],
      });

      if (extras && extras['card']) {
        // Fill payment details if card was provided
        const cardInput = page.locator(
          'input[placeholder*="card" i], input[name*="card" i], input[data-testid*="card"]',
        ).first();

        if (await cardInput.count() > 0) {
          await cardInput.fill(extras['card']);
          ctx.onLog(`[Journey/ecommerce] Filled card number`);
          await shot(page, ctx, 'checkout-payment-filled');
        } else {
          ctx.onLog('[Journey/ecommerce] No card input visible on checkout page');
        }
      } else {
        ctx.onLog('[Journey/ecommerce] Payment step skipped — no card provided');
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

      // Try to select a result
      const firstResult = page.locator(
        'button:has-text("Book"), button:has-text("Reserve"), a:has-text("Select"), a:has-text("Book Now")',
      ).first();

      if (await firstResult.count() > 0) {
        // Pre-action gate before confirming a booking
        const extras = ctx.onPreActionNeeded?.({
          type: 'booking_confirm',
          description: 'Confirm booking / reservation',
          requiredExtras: [],
        });

        if (extras !== null) {
          await firstResult.click();
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await shot(page, ctx, 'booking-confirm-page');
          ctx.onLog('[Journey/booking] Opened booking confirm page');
        } else {
          ctx.onLog('[Journey/booking] Booking confirmation skipped by pre-action gate');
        }
      }
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

  // Invalid login test — use findVisibleErrorText to avoid empty placeholder containers
  await usernameInput.fill('invalid_user_qa_test');
  await passwordInput.fill('wrongpassword123');
  await submitBtn.click();

  // Wait for error to render (some apps have async validation)
  const errorMsg = await findVisibleErrorText(page, 1000);

  const s1 = await shot(page, ctx, 'auth-invalid-login');

  if (!errorMsg) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Journey',
      title: 'No error message shown for invalid login credentials',
      steps: ['Enter invalid username and password', 'Click Login', 'Wait 1s for error'],
      expected: 'Clear, visible error message',
      actual: 'No error message with text found after 1s (empty containers excluded)',
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

  // Valid login test (only if credentials are fully provided)
  const creds = config.credentials;
  if (!creds || creds.type === 'none' || !creds.username || !creds.password) {
    ctx.onLog('[Journey/auth-portal] No valid credentials configured — skipping valid login test');
    if (!creds?.username) ctx.onLog('[Journey/auth-portal] Missing: username');
    if (!creds?.password) ctx.onLog('[Journey/auth-portal] Missing: password');
    return;
  }

  // Re-navigate to a clean login page state
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const usernameInput2 = page
    .locator('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]')
    .first();
  const passwordInput2 = page.locator('input[type="password"]').first();
  const submitBtn2 = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")')
    .first();

  if ((await usernameInput2.count()) === 0 || (await passwordInput2.count()) === 0) {
    ctx.onLog('[Journey/auth-portal] Could not find login form inputs after re-navigation');
    return;
  }

  // Verify credentials are non-empty before attempting login
  const username = creds.username.trim();
  const password = creds.password.trim();
  if (!username || !password) {
    ctx.onLog('[Journey/auth-portal] Credentials present but empty after trim — skipping valid login test');
    return;
  }

  ctx.onLog(`[Journey/auth-portal] Attempting login as: ${username} (password: ${'*'.repeat(Math.min(password.length, 8))})`);

  await usernameInput2.fill(username);
  await passwordInput2.fill(password);
  await submitBtn2.click().catch(() => {});

  // Wait for navigation or dynamic login completion
  await page.waitForTimeout(2000);
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  } catch {
    // Some SPAs don't fire domcontentloaded on login redirect — continue anyway
  }

  const s2 = await shot(page, ctx, 'auth-valid-login');
  const currentUrl = page.url();
  const stillOnLogin =
    (await page.locator('input[type="password"]').count()) > 0 &&
    currentUrl === config.targetUrl;

  if (stillOnLogin) {
    // Check if there's an error message explaining why login failed
    const loginError = await findVisibleErrorText(page, 500);
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Journey',
      title: 'Valid credentials did not complete login',
      steps: [
        `Enter username: ${username}`,
        `Enter password (${password.length} chars)`,
        'Click Login button',
        'Wait 2s for redirect',
      ],
      expected: 'Navigate away from login page to authenticated area',
      actual: loginError
        ? `Still on login page — error shown: "${loginError.slice(0, 100)}"`
        : `Still on login page at ${currentUrl} — verify credentials are correct`,
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

// ── Fintech ───────────────────────────────────────────────────────────────────

async function runFintechJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/fintech] View balance → initiate transfer → confirm');

  await shot(page, ctx, 'fintech-landing');

  // Check balance/account section
  const balanceEl = page.locator(
    '[class*="balance"], [data-testid*="balance"], :has-text("Balance"), :has-text("Available")',
  ).first();

  if (await balanceEl.count() > 0) {
    const balanceText = await balanceEl.textContent().catch(() => '');
    ctx.onLog(`[Journey/fintech] Balance visible: "${balanceText?.trim().slice(0, 40)}"`);
  }

  // Find transfer/send flow
  const transferBtn = page.locator(
    'button:has-text("Transfer"), button:has-text("Send"), a:has-text("Transfer"), a:has-text("Pay")',
  ).first();

  if (await transferBtn.count() > 0) {
    // Pre-action gate before any payment/transfer
    const extras = ctx.onPreActionNeeded?.({
      type: 'payment',
      description: 'Initiate fund transfer or payment',
      requiredExtras: ['phone'],
    });

    if (extras !== null) {
      await transferBtn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await shot(page, ctx, 'fintech-transfer-form');
      ctx.onLog('[Journey/fintech] Transfer form opened');

      // Fill phone/account if available
      if (extras?.['phone']) {
        const phoneInput = page.locator('input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]').first();
        if (await phoneInput.count() > 0) {
          await phoneInput.fill(extras['phone']);
          ctx.onLog('[Journey/fintech] Filled phone for transfer');
        }
      }
    } else {
      ctx.onLog('[Journey/fintech] Transfer flow skipped — waiting for user confirmation');
    }
  } else {
    ctx.onLog('[Journey/fintech] No transfer button found — running generic navigation');
    await runGenericJourney(page, ctx);
  }
}

// ── Social ────────────────────────────────────────────────────────────────────

async function runSocialJourney(page: Page, ctx: ExecutorContext): Promise<void> {
  ctx.onLog('[Journey/social] Browse feed → open profile → interact');

  await shot(page, ctx, 'social-feed');

  // Open a profile or post
  const profileLink = page.locator(
    'a[href*="/user"], a[href*="/profile"], a[href*="/@"], [class*="avatar"] a',
  ).first();

  if (await profileLink.count() > 0) {
    await profileLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await shot(page, ctx, 'social-profile');
    ctx.onLog('[Journey/social] Opened profile page');
  }

  // Try liking/following — pre-action gate
  const interactBtn = page.locator(
    'button:has-text("Follow"), button[aria-label*="like" i], button:has-text("Like")',
  ).first();

  if (await interactBtn.count() > 0) {
    const extras = ctx.onPreActionNeeded?.({
      type: 'generic',
      description: 'Interact with social content (follow/like)',
      requiredExtras: [],
    });

    if (extras !== null) {
      await interactBtn.click();
      await page.waitForTimeout(500);
      await shot(page, ctx, 'social-after-interact');
      ctx.onLog('[Journey/social] Interaction button clicked');
    }
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const JOURNEY_MAP: Record<SiteType, (page: Page, ctx: ExecutorContext) => Promise<void>> = {
  ecommerce: runEcommerceJourney,
  booking: runBookingJourney,
  'auth-portal': runAuthPortalJourney,
  'saas-dashboard': runSaasDashboardJourney,
  'blog-cms': runBlogJourney,
  social: runSocialJourney,
  fintech: runFintechJourney,
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
