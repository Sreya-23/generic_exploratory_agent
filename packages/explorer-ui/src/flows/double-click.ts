import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Analytics/telemetry beacons fire once per click BY DESIGN — that's their whole job, not
// evidence of a missing debounce on the actual business action. Confirmed via a real report:
// clicking a generic button counted as "not debounced" purely because it also fired several
// unagi.amazon.in / unagi-eu.amazon.com metrics POSTs alongside the real request, which would
// happen on every single click regardless of any debounce logic on the button itself.
const ANALYTICS_BEACON_PATTERN =
  /unagi|analytics|telemetry|\/metrics\/|beacon|\/collect\b|\/pixel\b|google-analytics|googletagmanager|doubleclick\.net|segment\.(io|com)|mixpanel|amplitude|\/csm\/|\.eel\.katal\./i;

// Buttons that trigger state mutations — highest risk for duplicate actions.
// Ordered: transactional first (highest impact), then general actions.
const ACTION_BUTTON_SELECTORS = [
  // E-commerce / transactional
  { sel: 'button:has-text("Add to cart")',      label: 'Add to cart',   kind: 'cart' },
  { sel: 'button:has-text("Add to Cart")',      label: 'Add to cart',   kind: 'cart' },
  { sel: 'button:has-text("Place order")',      label: 'Place order',   kind: 'order' },
  { sel: 'button:has-text("Pay")',              label: 'Pay',           kind: 'payment' },
  { sel: 'button:has-text("Confirm")',          label: 'Confirm',       kind: 'payment' },
  { sel: 'button:has-text("Checkout")',         label: 'Checkout',      kind: 'checkout' },
  { sel: 'button:has-text("Buy")',              label: 'Buy',           kind: 'order' },
  // Destructive
  { sel: 'button:has-text("Delete")',           label: 'Delete',        kind: 'destructive' },
  { sel: 'button:has-text("Remove")',           label: 'Remove',        kind: 'destructive' },
  // Social / engagement
  { sel: 'button:has-text("Send")',             label: 'Send',          kind: 'send' },
  { sel: 'button:has-text("Submit")',           label: 'Submit',        kind: 'submit' },
  { sel: 'button:has-text("Save")',             label: 'Save',          kind: 'submit' },
  { sel: 'button:has-text("Like")',             label: 'Like',          kind: 'social' },
  { sel: 'button:has-text("Follow")',           label: 'Follow',        kind: 'social' },
  { sel: 'button:has-text("Subscribe")',        label: 'Subscribe',     kind: 'social' },
  // Generic fallback
  { sel: 'button[type="submit"]',               label: 'submit',        kind: 'submit' },
  { sel: 'input[type="submit"]',                label: 'submit',        kind: 'submit' },
];

const TRANSACTIONAL_KINDS = new Set(['cart', 'order', 'payment', 'checkout', 'destructive', 'send']);

/**
 * Reads cart badge / item counter from common patterns used by apps.
 * Returns the count as a number, or null if not found.
 */
async function readCartCount(page: Page): Promise<number | null> {
  const cartSelectors = [
    '.shopping_cart_badge',          // Sauce Demo
    '[class*="cart-count"]',
    '[class*="cart_count"]',
    '[class*="cart-badge"]',
    '[class*="badge"]',
    '[data-testid*="cart"]',
    '[aria-label*="cart" i] [class*="count"]',
    '[aria-label*="basket" i] [class*="count"]',
  ];
  for (const sel of cartSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      const text = await el.textContent().catch(() => null);
      const n = parseInt(text ?? '', 10);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/**
 * Fire N rapid clicks on a button using programmatic dispatch.
 * This is more reliable than calling .click() N times because it
 * doesn't wait for the browser's own event processing between calls.
 */
async function rapidClickN(page: Page, selector: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    // Bounded timeout matters especially here — this runs in a tight N-iteration loop, so
    // an unguarded default timeout would pay its full cost on EVERY iteration if selector
    // doesn't match anything, not just once.
    await page.locator(selector).first().click({ force: true, timeout: 2000 }).catch(() => {});
    // Tiny gap — realistic "fast human" clicking (50–80ms between clicks)
    await page.waitForTimeout(60);
  }
}

export async function runDoubleClick(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const pageTitle = await page.title().catch(() => 'unknown');
  const pageUrl = page.url();
  const isAuthPage = (await page.locator('input[type="password"]').count()) > 0;

  ctx.onLog(`[RapidClick] Scanning for action buttons on "${pageTitle}" (${pageUrl})`);

  const testedButtons: string[] = [];

  for (const { sel, label, kind } of ACTION_BUTTON_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) === 0) continue;
    if (!(await btn.isVisible().catch(() => false))) continue;

    // Skip if we already tested a button with the same label on this page
    if (testedButtons.includes(label)) continue;
    testedButtons.push(label);

    ctx.onLog(`[RapidClick] Testing: "${label}" (kind: ${kind})`);

    // Snapshot before action
    const shotBefore = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `rapid-${label.replace(/\s+/g, '-')}-before.png`);
    await page.screenshot({ path: shotBefore });

    // Read cart count before clicking (for cart-kind buttons)
    const cartBefore = kind === 'cart' ? await readCartCount(page) : null;

    // Monitor network requests during the click sequence
    let requestCount = 0;
    const requestUrls: string[] = [];
    const reqListener = (req: import('playwright').Request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && !ANALYTICS_BEACON_PATTERN.test(req.url())) {
        requestCount++;
        requestUrls.push(`${req.method()} ${req.url()}`);
      }
    };
    page.on('request', reqListener);

    // Click 5 times rapidly — covers both double-click and rage-click scenarios
    const CLICK_COUNT = 5;
    await rapidClickN(page, sel, CLICK_COUNT);
    await page.waitForTimeout(1500); // wait for all async effects to settle

    page.off('request', reqListener);

    const shotAfter = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `rapid-${label.replace(/\s+/g, '-')}-after.png`);
    await page.screenshot({ path: shotAfter });

    // ── Check 1: Was the button debounced / disabled? ──────────────────────
    // After first click a well-behaved button becomes disabled or shows a
    // loading state, preventing subsequent clicks from firing.
    const btnDisabledAfter = await btn.isDisabled().catch(() => false);
    const btnStillVisible = await btn.isVisible().catch(() => false);

    // ── Check 2: How many network requests fired? ──────────────────────────
    const isTransactional = TRANSACTIONAL_KINDS.has(kind);
    const severity = isTransactional ? 'high' : (isAuthPage ? 'medium' : 'medium');

    if (requestCount > 1) {
      ctx.onFinding({
        severity,
        area: 'UI-RapidClick',
        title: `"${label}" button not debounced — ${requestCount} requests on ${CLICK_COUNT} rapid clicks`,
        steps: [
          `Page: ${pageUrl} ("${pageTitle}")`,
          `Click "${label}" ${CLICK_COUNT} times in rapid succession (~60ms apart)`,
          'Monitor POST/PUT/PATCH/DELETE network requests',
        ],
        expected: `Only 1 request sent (button should disable or debounce after first click)`,
        actual: `${requestCount} requests fired: ${requestUrls.slice(0, 4).join(' | ')}`,
        evidence: [shotBefore, shotAfter],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else if (requestCount === 1) {
      ctx.onLog(`[RapidClick] "${label}" correctly debounced — 1 request on ${CLICK_COUNT} rapid clicks ✓`);
    } else {
      ctx.onLog(`[RapidClick] "${label}" fired no requests — may be client-side only`);
    }

    // ── Check 3: Cart quantity after rapid "Add to Cart" clicks ───────────
    if (kind === 'cart' && cartBefore !== null) {
      const cartAfter = await readCartCount(page);
      if (cartAfter !== null) {
        const added = cartAfter - cartBefore;
        if (added > 1) {
          ctx.onFinding({
            severity: 'high',
            area: 'UI-RapidClick',
            title: `"Add to Cart" clicked ${CLICK_COUNT}× added ${added} items instead of 1`,
            steps: [
              `Note cart count: ${cartBefore}`,
              `Click "Add to Cart" ${CLICK_COUNT} times rapidly`,
              `Check cart count`,
            ],
            expected: `Cart count increases by 1 regardless of click speed`,
            actual: `Cart went from ${cartBefore} → ${cartAfter} (${added} items added by ${CLICK_COUNT} rapid clicks)`,
            evidence: [shotBefore, shotAfter],
            reproRate: '1/1',
            automationCandidate: true,
          });
        } else if (added === 1) {
          ctx.onLog(`[RapidClick] "Add to Cart" correctly added 1 item despite ${CLICK_COUNT} rapid clicks ✓`);
        }
      }
    }

    // ── Check 4: Button never disabled — UX gap ───────────────────────────
    // If button stays enabled after click, user has no visual feedback that
    // the action is in progress (leads to rage-clicking)
    if (requestCount >= 1 && !btnDisabledAfter && btnStillVisible && isTransactional) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-RapidClick',
        title: `"${label}" button stays enabled after click — no loading/disabled state`,
        steps: [
          `Click "${label}"`,
          `Observe button state while request is in-flight`,
        ],
        expected: 'Button disabled or shows loading indicator after click to prevent rage-clicking',
        actual: 'Button remains fully clickable with no visual feedback — users may click multiple times',
        evidence: [shotAfter],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }

    // Only test up to 3 distinct button types per page to avoid noise
    if (testedButtons.length >= 3) break;
  }

  if (testedButtons.length === 0) {
    ctx.onLog('[RapidClick] No action buttons found on this page');
  }
}
