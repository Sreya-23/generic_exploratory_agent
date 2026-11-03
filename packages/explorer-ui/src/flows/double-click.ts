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

// Error-reporting / session-replay / APM services send one report per error or event by design.
// Observed false positive (SauceDemo error_user): each failing "Add to cart" click sent a crash
// report to submit.backtrace.io, and 3 crash reports were read as "3 add-to-cart requests".
const MONITORING_PATTERN =
  /backtrace\.io|sentry\.io|ingest\.sentry|bugsnag|rollbar|datadoghq|browser-intake|newrelic|nr-data\.net|logrocket|fullstory|hotjar|clarity\.ms|raygun|trackjs|honeybadger|\/(log|logs|errors?|telemetry|rum|crash|report-error)(\/|\?|$)/i;

/** Registrable domain, e.g. shop.example.co.uk → example.co.uk, api.example.com → example.com. */
function siteDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const twoPartTld = tld.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(sld);
  return parts.slice(twoPartTld ? -3 : -2).join('.');
}

/**
 * Is this request one of the SITE's own actions (as opposed to a third-party side effect)?
 * - same registrable domain as the page (shop.example.com → api.example.com counts), or
 * - an origin the site was already seen calling as its API during recon/crawl (covers apps
 *   whose backend lives elsewhere, e.g. myshop-api.herokuapp.com),
 * and never an analytics beacon or error-reporting/monitoring call.
 */
function isOwnActionRequest(url: string, pageHost: string, knownApiOrigins: Set<string>): boolean {
  if (ANALYTICS_BEACON_PATTERN.test(url) || MONITORING_PATTERN.test(url)) return false;
  try {
    const u = new URL(url);
    return siteDomain(u.hostname) === siteDomain(pageHost) || knownApiOrigins.has(u.origin);
  } catch {
    return false;
  }
}

function knownApiOriginsFrom(ctx: ExecutorContext): Set<string> {
  const out = new Set<string>();
  for (const e of ctx.discoveredApiEndpoints ?? []) {
    const m = e.match(/https?:\/\/[^/\s]+/);
    if (!m) continue;
    if (ANALYTICS_BEACON_PATTERN.test(m[0]) || MONITORING_PATTERN.test(m[0])) continue;
    out.add(m[0]);
  }
  return out;
}

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
  // Many shops hide the badge entirely when the cart is empty — a visible cart link with no
  // badge is a count of 0, not "unknown".
  const cartLink = page.locator('a[href*="cart" i], a[class*="cart" i], [data-test*="cart" i], [aria-label*="cart" i]').first();
  if ((await cartLink.count().catch(() => 0)) > 0) return 0;
  return null;
}

/**
 * §16 — toggle idempotency: Like/Follow/Subscribe-style buttons are binary state toggles, and
 * two deliberate, spaced clicks (not the rapid-fire stress test below — this is about STATE
 * correctness, not request debouncing) should always return to the original state, matching
 * the doc's own "Like, Like, Unlike, Like" example. Generic on purpose — reads aria-pressed/
 * aria-checked first (the ARIA-correct signal), then falls back to the button's own visible
 * text (the extremely common Like⇄Unlike / Follow⇄Following text-swap pattern). Returns null
 * (inconclusive, not asserted either way) when neither signal is available, rather than
 * guessing from something fragile like a class name.
 */
async function readToggleState(page: Page, selector: string): Promise<string | null> {
  const btn = page.locator(selector).first();
  const ariaPressed = await btn.getAttribute('aria-pressed').catch(() => null);
  if (ariaPressed !== null) return `aria-pressed:${ariaPressed}`;
  const ariaChecked = await btn.getAttribute('aria-checked').catch(() => null);
  if (ariaChecked !== null) return `aria-checked:${ariaChecked}`;
  const text = (await btn.textContent().catch(() => null))?.trim();
  return text ? `text:${text}` : null;
}

async function checkToggleIdempotency(
  page: Page,
  ctx: ExecutorContext,
  selector: string,
  label: string,
  pageUrl: string,
  pageTitle: string,
): Promise<void> {
  const originalState = await readToggleState(page, selector);
  if (originalState === null) {
    ctx.onLog(`[RapidClick] "${label}": no aria-pressed/aria-checked/text signal available — skipping toggle-idempotency check`);
    return;
  }

  const btn = page.locator(selector).first();
  await btn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  const afterFirstClick = await readToggleState(page, selector);

  if (afterFirstClick === originalState) {
    // The click may be a genuinely non-toggling action (e.g. "Subscribe" with no unsubscribe
    // path from this button) — not evidence of a bug on its own, and nothing to toggle back.
    ctx.onLog(`[RapidClick] "${label}": state did not change after one click ("${originalState}") — not a toggle from this button, skipping`);
    return;
  }

  await btn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  const afterSecondClick = await readToggleState(page, selector);

  if (afterSecondClick === originalState) {
    ctx.onLog(`[RapidClick] "${label}" toggle idempotency correct: two clicks return to the original state ("${originalState}")`);
    return;
  }

  const shotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `toggle-idempotency-${label.replace(/\s+/g, '-')}.png`);
  await page.screenshot({ path: shotPath }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'UI-RapidClick',
    title: `"${label}" does not return to its original state after two clicks`,
    steps: [`Page: ${pageUrl} ("${pageTitle}")`, `Note the state of "${label}" (${originalState})`, `Click "${label}"`, `Click "${label}" again`],
    expected: `Two clicks on a toggle-shaped control should return to the original state ("${originalState}")`,
    actual: `After two clicks, state is "${afterSecondClick}" — expected "${originalState}" (after one click it was "${afterFirstClick}")`,
    evidence: [shotPath],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl,
    confidence: 'heuristic',
    confidenceReason: 'Based on aria-pressed/aria-checked/visible-text as a proxy for toggle state — a control with more than two real states (e.g. a three-way cycle) would also trigger this without being a bug; verify the control is genuinely meant to be a binary toggle before treating as confirmed.',
  });
}

/**
 * Fire N rapid clicks on a button using programmatic dispatch.
 * This is more reliable than calling .click() N times because it
 * doesn't wait for the browser's own event processing between calls.
 */
async function rapidClickN(page: Page, selector: string, n: number): Promise<Set<string>> {
  const labelsSeen = new Set<string>();
  // Pin the element ONCE. Re-resolving `selector` before every click silently moved on to the
  // NEXT matching button whenever the first one changed its label (Add to cart → Remove), so
  // "5 rapid clicks on one button" was really 5 clicks spread over several products.
  const handle = await page.locator(selector).first().elementHandle({ timeout: 2000 }).catch(() => null);
  for (let i = 0; i < n; i++) {
    // Bounded timeout matters especially here — this runs in a tight N-iteration loop, so
    // an unguarded default timeout would pay its full cost on EVERY iteration if selector
    // doesn't match anything, not just once.
    if (handle) await handle.click({ force: true, timeout: 2000 }).catch(() => {});
    else await page.locator(selector).first().click({ force: true, timeout: 2000 }).catch(() => {});
    // Sample the label after each click — a toggle may land back on its original label after an
    // even number of effective clicks, so the final label alone can't identify it.
    if (handle) {
      const t = ((await handle.textContent().catch(() => '')) ?? '').trim();
      if (t) labelsSeen.add(t);
    }
    // Tiny gap — realistic "fast human" clicking (50–80ms between clicks)
    await page.waitForTimeout(60);
  }
  return labelsSeen;
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

    // Toggle idempotency runs BEFORE the rapid-click stress test below, on a clean/known
    // baseline — two deliberate, spaced clicks return the control to its starting state (when
    // idempotent), so the rapid-click test that follows also starts from a consistent baseline
    // regardless of what this check found.
    if (kind === 'social') {
      await checkToggleIdempotency(page, ctx, sel, label, pageUrl, pageTitle);
    }

    // Snapshot before action
    const shotBefore = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `rapid-${label.replace(/\s+/g, '-')}-before.png`);
    await page.screenshot({ path: shotBefore });

    // Read cart count before clicking (for cart-kind buttons)
    const cartBefore = kind === 'cart' ? await readCartCount(page) : null;

    // Monitor the SITE's own write requests during the click sequence (see isOwnActionRequest),
    // with timing, so "no loading state" is only judged for actions that actually waited on a server.
    const pageHost = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return '';
      }
    })();
    const apiOrigins = knownApiOriginsFrom(ctx);
    let requestCount = 0;
    let ignoredCount = 0;
    const requestUrls: string[] = [];
    const started = new Map<import('playwright').Request, number>();
    let slowestMs = 0;
    const reqListener = (req: import('playwright').Request) => {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
      if (!isOwnActionRequest(req.url(), pageHost, apiOrigins)) {
        ignoredCount++;
        return;
      }
      requestCount++;
      requestUrls.push(`${req.method()} ${req.url()}`);
      started.set(req, Date.now());
    };
    const doneListener = (req: import('playwright').Request) => {
      const t = started.get(req);
      if (t !== undefined) slowestMs = Math.max(slowestMs, Date.now() - t);
    };
    page.on('request', reqListener);
    page.on('requestfinished', doneListener);
    page.on('requestfailed', doneListener);

    const labelBefore = ((await btn.textContent().catch(() => '')) ?? '').trim();
    const pinned = await btn.elementHandle({ timeout: 2000 }).catch(() => null);

    // Click 5 times rapidly — covers both double-click and rage-click scenarios
    const CLICK_COUNT = 5;
    const labelsSeen = await rapidClickN(page, sel, CLICK_COUNT);
    await page.waitForTimeout(1500); // wait for all async effects to settle

    page.off('request', reqListener);
    page.off('requestfinished', doneListener);
    page.off('requestfailed', doneListener);
    if (ignoredCount > 0) {
      ctx.onLog(`[RapidClick] "${label}": ignored ${ignoredCount} third-party/monitoring request(s) (not the site's own action)`);
    }

    const shotAfter = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `rapid-${label.replace(/\s+/g, '-')}-after.png`);
    await page.screenshot({ path: shotAfter });

    const btnDisabledAfter = pinned
      ? await pinned.isDisabled().catch(() => false)
      : await btn.isDisabled().catch(() => false);
    const btnStillVisible = pinned ? await pinned.isVisible().catch(() => false) : await btn.isVisible().catch(() => false);
    const labelAfter = pinned ? ((await pinned.textContent().catch(() => '')) ?? '').trim() : labelBefore;
    // A button that changes its own label when clicked (Add to cart ⇄ Remove, Follow ⇄ Unfollow)
    // is a TOGGLE: each click is a distinct, intended action, so several requests are expected.
    labelsSeen.add(labelBefore);
    const isToggle = (!!labelAfter && labelAfter !== labelBefore) || labelsSeen.size > 1;

    const isTransactional = TRANSACTIONAL_KINDS.has(kind);
    const severity = isTransactional ? 'high' : 'medium';
    const cartAfter = kind === 'cart' && cartBefore !== null ? await readCartCount(page) : null;
    const cartAdded = cartAfter !== null && cartBefore !== null ? cartAfter - cartBefore : null;

    // ── Check 1/2: duplicate submissions (non-toggle buttons only) ─────────
    if (isToggle) {
      ctx.onLog(`[RapidClick] "${label}" is a toggle ("${labelBefore}" → "${labelAfter}") — ${requestCount} request(s) for ${CLICK_COUNT} distinct clicks is expected`);
    } else if (requestCount > 1 && cartAdded !== null && cartAdded <= 1) {
      // The cart only grew by one, so whatever the extra requests were, nothing was duplicated.
      ctx.onLog(`[RapidClick] "${label}": ${requestCount} requests but the cart only grew by ${cartAdded} — no duplicate effect`);
    } else if (requestCount > 1) {
      ctx.onFinding({
        severity,
        area: 'UI-RapidClick',
        title: `"${label}" button not debounced — ${requestCount} requests on ${CLICK_COUNT} rapid clicks`,
        steps: [
          `Page: ${pageUrl} ("${pageTitle}")`,
          `Click "${label}" ${CLICK_COUNT} times in rapid succession (~60ms apart)`,
          "Monitor the site's own POST/PUT/PATCH/DELETE requests",
        ],
        expected: `Only 1 request sent (button should disable or debounce after first click)`,
        actual: `${requestCount} requests fired: ${requestUrls.slice(0, 4).join(' | ')}`,
        evidence: [shotBefore, shotAfter],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl,
        confidence: 'verified',
        confidenceReason: "Counted only write requests to the site's own servers (third-party analytics and error reporting excluded).",
      });
    } else if (requestCount === 1) {
      ctx.onLog(`[RapidClick] "${label}" correctly debounced — 1 request on ${CLICK_COUNT} rapid clicks ✓`);
    } else {
      ctx.onLog(`[RapidClick] "${label}" sent no requests to the site's server — client-side action`);
    }

    // ── Check 3: cart state after rapid clicks ───────────────────────────
    if (cartAdded !== null) {
      // Toggle: the final label says whether the item should be in the cart (label now offers
      // "Remove" ⇒ item added ⇒ +1; label back to "Add" ⇒ +0). Plain add button: at most +1.
      const expectedAdded = isToggle ? (/remove|added|in cart/i.test(labelAfter) ? 1 : 0) : null;
      const wrong = expectedAdded !== null ? cartAdded !== expectedAdded : cartAdded > 1;
      if (wrong) {
        ctx.onFinding({
          severity: 'high',
          area: 'UI-RapidClick',
          title: `Rapid clicks on "${label}" leave the cart count wrong (${cartBefore} → ${cartAfter})`,
          steps: [`Note cart count: ${cartBefore}`, `Click "${label}" ${CLICK_COUNT} times rapidly`, 'Check cart count and the button label'],
          expected:
            expectedAdded !== null
              ? `Button now reads "${labelAfter}", so the cart should be ${cartBefore! + expectedAdded}`
              : `Cart count increases by at most 1 regardless of click speed`,
          actual: `Cart went from ${cartBefore} → ${cartAfter}`,
          evidence: [shotBefore, shotAfter],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl,
          confidence: 'verified',
          confidenceReason: 'Cart counter read before and after, compared with what the button label says the state is.',
        });
      } else {
        ctx.onLog(`[RapidClick] Cart count consistent after rapid clicks (${cartBefore} → ${cartAfter}) ✓`);
      }
    }

    // ── Check 4: no loading state on a SLOW server action ─────────────────
    // Only meaningful when the click really waited on the site's server; an instant client-side
    // action (local cart, toggle, filter) has nothing to show a spinner for.
    if (requestCount >= 1 && slowestMs >= 300 && !btnDisabledAfter && btnStillVisible && isTransactional && !isToggle) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-RapidClick',
        title: `"${label}" button stays enabled while its request is in flight — no loading/disabled state`,
        steps: [`Click "${label}"`, `Observe the button during the ${slowestMs}ms server request`],
        expected: 'Button disabled or shows loading indicator after click to prevent rage-clicking',
        actual: `The request took ${slowestMs}ms and the button stayed fully clickable with no visual feedback`,
        evidence: [shotAfter],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl,
        confidence: 'verified',
        confidenceReason: "Measured the site's own request duration and the button's disabled state.",
      });
    }

    // Only test up to 3 distinct button types per page to avoid noise
    if (testedButtons.length >= 3) break;
  }

  if (testedButtons.length === 0) {
    ctx.onLog('[RapidClick] No action buttons found on this page');
  }
}
