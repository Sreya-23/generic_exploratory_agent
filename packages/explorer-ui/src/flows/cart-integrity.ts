import type { Locator, Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage, isRiskyActionLabel } from './helpers.js';
import { checkFieldRetention } from './input-retention.js';
import { detectListItems, itemLocator, sameOriginRoutes, snap, spreadIndices } from './list-items.js';

// A21 — Cart integrity. The ecommerce journey adds ONE item and checks the badge moved; it stops
// at the card field. Real cart bugs are usually about consistency across several steps: some
// items' Add buttons do nothing, Remove doesn't undo Add, the cart page disagrees with the
// badge, a checkout field drops what was typed, the totals don't add up. This walks the cart as
// a user would — several spread-out items, an undo, the cart page, the checkout details step,
// the order summary — checking at each step that the numbers and names agree.
//
// Safety: runs in the task's own throwaway browser context. "Remove" is only ever clicked on an
// item THIS flow just added (undoing its own action, never touching pre-existing data). Checkout
// fields follow input-retention's risk tiers (PII only from credentials.extras). It never clicks
// Finish / Place order / Pay — it stops at the summary page, before any order exists.

const ADD_RE = /^\s*(add\s*to\s*(cart|bag|basket|trolley)|add)\s*$/i;
const ADD_ATTR_SEL = '[data-test*="add-to-cart" i], [id*="add-to-cart" i], [class*="add-to-cart" i], [name*="add-to-cart" i]';
const REMOVE_RE = /^\s*remove(\s*from\s*(cart|bag|basket))?\s*$/i;
const CART_LINK_SEL =
  'a[href*="cart" i], a[href*="basket" i], a[href*="bag" i], a[class*="cart" i], a[data-test*="cart" i], [data-test*="cart" i] a, ' +
  '[aria-label*="cart" i], [class*="cart_link" i], [class*="cart-link" i], [class*="shopping_cart" i] a';
const BADGE_SEL =
  '[data-test*="cart-badge" i], [class*="cart_badge" i], [class*="cart-badge" i], [class*="cart-count" i], ' +
  '[class*="cart_count" i], [class*="cart"] [class*="badge" i], [class*="cart"] [class*="count" i], [aria-label*="cart" i] [class*="badge" i]';

async function readBadge(page: Page): Promise<number | null> {
  const hasCart = (await page.locator(CART_LINK_SEL).count().catch(() => 0)) > 0;
  const badge = page.locator(BADGE_SEL).first();
  if ((await badge.count().catch(() => 0)) === 0 || !(await badge.isVisible().catch(() => false))) {
    return hasCart ? 0 : null; // a cart with no badge visible = empty cart
  }
  const n = parseInt(((await badge.textContent().catch(() => '')) ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

async function addButtonIn(scope: Locator): Promise<Locator | null> {
  const byAttr = scope.locator(ADD_ATTR_SEL).first();
  if ((await byAttr.count().catch(() => 0)) > 0 && (await byAttr.isVisible().catch(() => false))) return byAttr;
  const byText = scope.locator('button:visible, [role="button"]:visible, input[type="button"]:visible, input[type="submit"]:visible').filter({ hasText: ADD_RE });
  if ((await byText.count().catch(() => 0)) > 0) return byText.first();
  return null;
}

async function findButton(page: Page, re: RegExp): Promise<Locator | null> {
  const candidates = page.locator('button:visible, a:visible, [role="button"]:visible, input[type="submit"]:visible');
  const n = Math.min(await candidates.count().catch(() => 0), 80);
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    const label = ((await el.textContent().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (re.test(label) && !isRiskyActionLabel(label)) return el;
  }
  return null;
}

function money(text: string, label: RegExp): number | null {
  for (const line of text.split('\n')) {
    if (!label.test(line)) continue;
    const m = line.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*$/) ?? line.match(/[$€£₹¥]\s?(\d[\d,]*(?:\.\d{1,2})?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

export async function runCartIntegrity(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  // 1. Find a page with add-to-cart controls (landing page first, then known routes).
  const startUrl = page.url();
  let found = false;
  for (const url of [startUrl, ...sameOriginRoutes(ctx, startUrl, 4)]) {
    if (url !== page.url()) {
      const ok = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(600);
    }
    if (await isLoginWallPage(page)) continue;
    if (await addButtonIn(page.locator('body'))) {
      found = true;
      break;
    }
  }
  if (!found) {
    ctx.onLog('[CartIntegrity] No add-to-cart controls found — not a shop-like page, skipping');
    return;
  }
  const listUrl = page.url();
  ctx.onLog(`[CartIntegrity] Shop list found at ${listUrl}`);

  // 2. Add several spread-out items, checking the badge after each.
  const list = await detectListItems(page);
  const targets: { name: string; scope: Locator }[] = [];
  if (list) {
    for (const idx of spreadIndices(list.items.length, 3)) {
      targets.push({ name: list.items[idx].name, scope: itemLocator(page, idx) });
    }
  } else {
    targets.push({ name: 'first item on page', scope: page.locator('body') });
  }

  let expected = (await readBadge(page)) ?? 0;
  const added: { name: string; scope: Locator }[] = [];
  for (const t of targets) {
    const btn = await addButtonIn(t.scope);
    if (!btn) continue;
    const before = await readBadge(page);
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const after = await readBadge(page);
    if (before !== null && after !== null && after !== before + 1) {
      ctx.onFinding({
        severity: 'high',
        area: 'UI-Cart',
        title: `Adding "${t.name}" to the cart does not update the cart count`,
        steps: [`Open ${listUrl}`, `Click the add-to-cart button for "${t.name}"`, 'Watch the cart count'],
        expected: `Cart count goes from ${before} to ${before + 1}`,
        actual: `Cart count is ${after}`,
        evidence: await snap(page, ctx, 'cart-add'),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: listUrl,
        confidence: 'verified',
        confidenceReason: 'Reads the cart counter immediately before and after a single add click.',
      });
      continue;
    }
    if (after !== null) expected = after;
    added.push(t);
    ctx.onLog(`[CartIntegrity] Added "${t.name}" — cart count ${after ?? 'unknown'}`);
  }
  if (added.length === 0) {
    ctx.onLog('[CartIntegrity] Could not add any item — stopping');
    return;
  }

  // 3. Undo: Remove on the last item we added must bring the count back down.
  let removedName: string | null = null;
  if (added.length >= 2 && list) {
    const last = added[added.length - 1];
    const removeBtn = last.scope.locator('button:visible, [role="button"]:visible').filter({ hasText: REMOVE_RE }).first();
    if ((await removeBtn.count().catch(() => 0)) > 0) {
      const before = await readBadge(page);
      await removeBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
      const after = await readBadge(page);
      if (before !== null && after !== null && after !== before - 1) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Cart',
          title: `Removing "${last.name}" from the cart does not update the cart count`,
          steps: [`Open ${listUrl}`, `Add "${last.name}" to the cart`, 'Click its Remove button', 'Watch the cart count'],
          expected: `Cart count goes from ${before} to ${before - 1}`,
          actual: `Cart count is ${after}`,
          evidence: await snap(page, ctx, 'cart-remove'),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: listUrl,
          confidence: 'verified',
          confidenceReason: 'Reads the cart counter immediately before and after undoing this flow\'s own add.',
        });
      } else {
        removedName = last.name;
        added.pop();
        if (after !== null) expected = after;
        ctx.onLog(`[CartIntegrity] Removed "${last.name}" — cart count ${after ?? 'unknown'}`);
      }
    }
  }

  // 4. Cart page must list exactly what was added.
  const cartLink = page.locator(CART_LINK_SEL).first();
  if ((await cartLink.count().catch(() => 0)) === 0) {
    ctx.onLog('[CartIntegrity] No cart link found — stopping after add/remove checks');
    return;
  }
  await cartLink.click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);
  const cartText = ((await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) ?? '').toLowerCase();
  const missing = list ? added.filter((a) => !cartText.includes(a.name.toLowerCase())).map((a) => a.name) : [];
  const stillThere = removedName && cartText.includes(removedName.toLowerCase()) ? removedName : null;
  if (missing.length > 0 || stillThere) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Cart',
      title: 'Cart page does not match what was added',
      steps: [`Open ${listUrl}`, `Add ${added.map((a) => `"${a.name}"`).join(', ')}${removedName ? `, add and then remove "${removedName}"` : ''}`, 'Open the cart'],
      expected: `Cart lists ${added.map((a) => `"${a.name}"`).join(', ')}${removedName ? ` and not "${removedName}"` : ''}`,
      actual: [missing.length ? `Missing: ${missing.join(', ')}` : '', stillThere ? `Still listed after removal: ${stillThere}` : ''].filter(Boolean).join('. '),
      evidence: await snap(page, ctx, 'cart-page'),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Checks the cart page text for the exact item names this flow added/removed.',
    });
  } else {
    ctx.onLog(`[CartIntegrity] Cart page lists the ${added.length} added item(s)`);
  }
  const badgeOnCart = await readBadge(page);
  if (badgeOnCart !== null && badgeOnCart !== expected) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Cart',
      title: 'Cart count changes when the cart page is opened',
      steps: [`Open ${listUrl}`, 'Add items to the cart', 'Open the cart page and compare the cart count'],
      expected: `Cart count stays ${expected}`,
      actual: `Cart count shows ${badgeOnCart}`,
      evidence: await snap(page, ctx, 'cart-badge'),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Same counter read on two pages within one session.',
    });
  }

  // 5. Checkout details step: fields must keep what is typed.
  const checkoutBtn = await findButton(page, /check\s*out|proceed/i);
  if (!checkoutBtn) {
    ctx.onLog('[CartIntegrity] No checkout button on the cart page — stopping');
    return;
  }
  await checkoutBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);
  if (await isLoginWallPage(page)) {
    ctx.onLog('[CartIntegrity] Checkout asks for login — stopping');
    return;
  }
  const form = page.locator('form:visible').first();
  const scope = (await form.count().catch(() => 0)) > 0 ? form : page.locator('body');
  const retention = await checkFieldRetention(page, ctx, { scope, restore: false, tag: 'CartIntegrity' });
  if (retention.issues > 0) {
    ctx.onLog('[CartIntegrity] Checkout fields lost data — not continuing past this step');
    return;
  }
  const emptyFields = await scope
    .locator('input:visible:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])')
    .evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).value && !(e as HTMLInputElement).disabled).length)
    .catch(() => 0);
  if (emptyFields > 0) {
    ctx.onLog(
      `[CartIntegrity] ${emptyFields} checkout field(s) need personal data — stopping before the summary. ` +
        'Add values in credentials.extras (e.g. postcode) to let this check reach the order totals.',
    );
    return;
  }
  const next = await findButton(page, /^\s*(continue|next|review|proceed)/i);
  if (!next) {
    ctx.onLog('[CartIntegrity] No continue button after checkout details — stopping');
    return;
  }
  await next.click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);

  // 6. Summary totals must add up. Never clicks Finish/Place order.
  const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) ?? '';
  const subtotal = money(text, /item\s*total|sub-?\s*total/i);
  const tax = money(text, /\btax\b|\bvat\b|\bgst\b/i);
  const total = money(text, /^\s*(order\s*)?total\b(?!.*item)/i);
  // Summary rows ("Item total", "Tax", "Total") are repeating siblings with prices too — exclude
  // them, and only trust the item sum when the detected rows are exactly the items in the cart.
  const summaryList = await detectListItems(
    page,
    Math.max(1, added.length),
    /^\s*(item\s*total|sub-?\s*total|total|tax|vat|gst|shipping|delivery|discount|fee)\b/i,
  );
  const rowsAreCartItems =
    !!summaryList &&
    summaryList.items.length === added.length &&
    summaryList.items.every((i) => i.price !== null && added.some((a) => a.name.toLowerCase() === i.name.toLowerCase()));
  const itemSum = rowsAreCartItems ? summaryList!.items.reduce((s, i) => s + (i.price ?? 0), 0) : null;
  if (!rowsAreCartItems) ctx.onLog('[CartIntegrity] Could not match summary rows to cart items — skipping the item-sum check');
  const problems: string[] = [];
  if (subtotal !== null && itemSum !== null && itemSum > 0 && Math.abs(itemSum - subtotal) > 0.011) {
    problems.push(`items add up to ${itemSum.toFixed(2)} but the subtotal says ${subtotal.toFixed(2)}`);
  }
  if (subtotal !== null && tax !== null && total !== null && Math.abs(subtotal + tax - total) > 0.011) {
    problems.push(`subtotal ${subtotal.toFixed(2)} + tax ${tax.toFixed(2)} = ${(subtotal + tax).toFixed(2)} but the total says ${total.toFixed(2)}`);
  }
  if (problems.length > 0) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Cart',
      title: 'Order summary totals do not add up',
      steps: [`Open ${listUrl}`, 'Add items, open the cart, start checkout, fill the details', 'Read the order summary'],
      expected: 'Subtotal equals the sum of item prices, and subtotal + tax equals the total',
      actual: problems.join('; '),
      evidence: await snap(page, ctx, 'cart-totals'),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Arithmetic on the amounts printed on the summary page.',
    });
  } else if (subtotal !== null || total !== null) {
    ctx.onLog('[CartIntegrity] Order summary totals add up');
  } else {
    ctx.onLog('[CartIntegrity] No totals recognised on the page after checkout details');
  }
  ctx.onLog('[CartIntegrity] Stopped at the summary — no order was placed');
}
