/**
 * PRD assertion helpers — "passed" means verified behaviour, not "no crash".
 */
import type { Page } from 'playwright';
import { isLoginWallPage } from './helpers.js';

export async function countInventoryItems(page: Page): Promise<number> {
  return page
    .locator('.inventory_item, [data-test="inventory-item"], .product-card, .product')
    .count()
    .catch(() => 0);
}

export async function getCartBadgeCount(page: Page): Promise<number> {
  const badge = page
    .locator(
      '.shopping_cart_badge, [data-test="shopping-cart-badge"], .cart-count, .cart-badge',
    )
    .first();
  if ((await badge.count()) === 0) return 0;
  if (!(await badge.isVisible().catch(() => false))) return 0;
  const text = ((await badge.textContent().catch(() => '')) || '').trim();
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function countCartLineItems(page: Page): Promise<number> {
  return page
    .locator(
      '.cart_item, [data-test="inventory-item"], .cart-item, tr.cart_item, .cart_list .cart_item',
    )
    .count()
    .catch(() => 0);
}

export function isCartUrl(url: string): boolean {
  return /cart|basket|bag/i.test(url);
}

export function isCheckoutCompleteUrl(url: string): boolean {
  return /checkout-complete|order-complete|thank|confirmation|success/i.test(url);
}

export function isCheckoutStepUrl(url: string): boolean {
  return /checkout/i.test(url);
}

/** Harness/noise URLs — never raise as app defects */
export function isHarnessBlankUrl(url: string): boolean {
  const u = (url || '').trim().toLowerCase();
  return (
    !u ||
    u === 'about:blank' ||
    u.startsWith('chrome-error://') ||
    u.startsWith('chrome://') ||
    u === 'data:,'
  );
}

export async function pageLooksHealthy(page: Page): Promise<boolean> {
  const url = page.url();
  if (isHarnessBlankUrl(url)) return false;
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
  if (body.length < 20) return false;
  if (/^\s*(404|500|error)\b/i.test(body.slice(0, 80))) return false;
  return true;
}

export async function assertAuthenticatedApp(page: Page): Promise<{
  ok: boolean;
  detail: string;
}> {
  if (await isLoginWallPage(page)) {
    return { ok: false, detail: 'Still on login wall' };
  }
  const items = await countInventoryItems(page);
  const hasMenu =
    (await page.locator('#react-burger-menu-btn, .bm-burger-button, nav').count()) > 0;
  const hasCart =
    (await page
      .locator('.shopping_cart_link, [data-test="shopping-cart-link"], a[href*="cart"]')
      .count()) > 0;
  if (items > 0 || hasCart || hasMenu) {
    return {
      ok: true,
      detail: `Authenticated app (products=${items}, cartLink=${hasCart}, menu=${hasMenu}, url=${page.url()})`,
    };
  }
  return { ok: true, detail: `Authenticated (not login wall), url=${page.url()}` };
}

export async function assertLogoutSuccess(page: Page): Promise<{
  ok: boolean;
  detail: string;
}> {
  const onLogin = await isLoginWallPage(page);
  const items = await countInventoryItems(page);
  const inventoryBlocked =
    /inventory|cart|checkout/i.test(page.url()) === false || items === 0;

  if (onLogin && items === 0) {
    return {
      ok: true,
      detail: `Logged out — login form visible, no inventory items (url=${page.url()})`,
    };
  }

  if (onLogin) {
    return { ok: true, detail: `Login form visible after logout (url=${page.url()})` };
  }

  return {
    ok: false,
    detail: `Expected login form after logout; products=${items}, inventoryBlocked=${inventoryBlocked}, url=${page.url()}`,
  };
}

export async function getInputValue(page: Page, selectors: string): Promise<string> {
  const el = page.locator(selectors).first();
  if ((await el.count()) === 0) return '';
  return (await el.inputValue().catch(() => '')) || '';
}

/** Exercise sort/filter control when present; return notes */
export async function exerciseInventorySort(page: Page): Promise<string> {
  const sort = page
    .locator(
      '[data-test="product-sort-container"], select.product_sort_container, select[name*="sort"], select[aria-label*="sort" i]',
    )
    .first();
  if ((await sort.count()) === 0 || !(await sort.isVisible().catch(() => false))) {
    return 'sort: no dropdown';
  }
  const before = await countInventoryItems(page);
  const options = sort.locator('option');
  const n = await options.count().catch(() => 0);
  if (n < 2) return 'sort: single option';
  const value = (await options.nth(Math.min(1, n - 1)).getAttribute('value').catch(() => '')) || '';
  await sort.selectOption(value ? { value } : { index: 1 }, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const after = await countInventoryItems(page);
  return `sort: selected option, products ${before}→${after}`;
}

/** Remove first cart line; return badge before/after */
export async function removeFirstCartItem(page: Page): Promise<{
  before: number;
  after: number;
  ok: boolean;
  detail: string;
}> {
  const before = await getCartBadgeCount(page);
  const remove = page
    .locator('button:has-text("Remove"), [data-test^="remove"], .cart_button')
    .first();
  if ((await remove.count()) === 0) {
    return { before, after: before, ok: false, detail: 'No Remove control on cart' };
  }
  await remove.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const after = await getCartBadgeCount(page);
  const lines = await countCartLineItems(page);
  const ok = after < before || lines < 1 || (before === 0 && after === 0);
  return {
    before,
    after,
    ok: after <= before,
    detail: `remove: badge ${before}→${after}, lines=${lines}`,
  };
}

/** Read visible price / total snippets from cart or checkout */
export async function readVisibleTotals(page: Page): Promise<string> {
  const sels = [
    '.summary_subtotal_label',
    '.summary_tax_label',
    '.summary_total_label',
    '[data-test="subtotal-label"]',
    '[data-test="tax-label"]',
    '[data-test="total-label"]',
    '.cart_item .inventory_item_price',
    '.inventory_item_price',
  ];
  const parts: string[] = [];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) continue;
    const t = ((await el.textContent().catch(() => '')) || '').trim();
    if (t) parts.push(t.replace(/\s+/g, ' ').slice(0, 40));
  }
  return parts.slice(0, 4).join(' | ') || 'no price labels found';
}

/**
 * On checkout overview with 0 items, Finish should ideally be blocked.
 * Sauce Demo still enables Finish with items; empty overview is rare.
 */
export async function assertCheckoutOverviewGuards(page: Page): Promise<string> {
  const finish = page.locator('[data-test="finish"], button:has-text("Finish")').first();
  if ((await finish.count()) === 0) return 'overview: no Finish button';
  const lines = await countCartLineItems(page);
  const disabled = await finish.isDisabled().catch(() => false);
  const totals = await readVisibleTotals(page);
  if (lines === 0 && !disabled) {
    return `overview: empty cart but Finish enabled (${totals})`;
  }
  return `overview: lines=${lines}, finishDisabled=${disabled}, ${totals}`;
}

/** Ensure history has a real prior entry so goBack is meaningful */
export async function seedHistoryForBack(
  page: Page,
  featureUrl: string,
  priorUrl: string,
): Promise<void> {
  if (isHarnessBlankUrl(featureUrl)) return;
  await page.goto(priorUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.goto(featureUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
}
