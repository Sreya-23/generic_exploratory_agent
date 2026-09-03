/**
 * Shared helpers used across flow files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';

/**
 * Polls for real rendered content instead of trusting a fixed wait or a "title stopped
 * changing" check to mean the page has finished loading. A different browser engine
 * (WebKit vs Chromium especially) can genuinely take longer to hydrate the same
 * client-rendered SPA — a fixed ~1.5-2s wait tuned against Chromium's speed samples
 * WebKit's page mid-load, seeing near-empty content and a stale app-shell title, and wrongly
 * concludes "this engine/device renders differently" when it would look identical given a
 * few more seconds. "Title stopped changing" doesn't catch this either — if the real title
 * update just hasn't started yet, an unchanging placeholder title looks "stable" too.
 */
export async function waitForRealContent(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { length, interactive } = await page
      .evaluate(() => ({
        length: (document.body?.innerText ?? '').trim().length,
        // A static app shell (logo, sidebar labels, nav text) can clear a text-length
        // threshold well before any actual button/link/input has mounted — confirmed by a
        // real dashboard whose sidebar+text passed this check while every clickable element
        // (Pay Now, tab controls, stat cards) was still loading, leaving Action Inventory to
        // scan a page with genuinely zero interactive elements. Requiring at least one
        // closes that gap without needing to know the expected count per page.
        interactive: document.querySelectorAll(
          'button:not([disabled]), a[href], input:not([type="hidden"]), select, [role="button"], [tabindex="0"]',
        ).length,
      }))
      .catch(() => ({ length: 0, interactive: 0 }));
    if (length > 100 && interactive > 0) return;
    await page.waitForTimeout(300);
  }
}

/** Path to this session's saved auth state (cookies + localStorage), or null if none exists. */
export function savedSessionStatePath(ctx: ExecutorContext): string | null {
  const stateFile = join(ctx.sessionsDir, ctx.sessionId, 'auth-state.json');
  return existsSync(stateFile) ? stateFile : null;
}

/**
 * Re-authenticates the CURRENT shared page/context from this session's saved auth state,
 * for flows that deliberately log the session out mid-test (e.g. B6 session-timeout clears
 * cookies + localStorage + sessionStorage to see what actually invalidates auth) and would
 * otherwise leave every LATER task in the same run working against a logged-out page.
 * That's not just a B6 concern — any later flow that reads the shared page's live state as
 * a "baseline" (cross-browser.ts, device-matrix.ts) silently compares real results against
 * a stale, logged-out baseline instead, making the real results look wrong when they're the
 * only ones still correct. Restoring here, once, at the source, is cheaper and more
 * reliable than making every downstream flow independently distrust the shared page.
 */
export async function restoreAuthenticatedState(page: Page, ctx: ExecutorContext): Promise<boolean> {
  const savedState = savedSessionStatePath(ctx);
  if (!savedState) return false;

  try {
    const state = JSON.parse(readFileSync(savedState, 'utf-8')) as {
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
    };

    if (state.cookies?.length) {
      await page
        .context()
        .addCookies(state.cookies as unknown as Parameters<BrowserContext['addCookies']>[0]);
    }

    const targetOrigin = new URL(page.url()).origin;
    const matchingOrigin = state.origins?.find((o) => o.origin === targetOrigin);
    if (matchingOrigin?.localStorage?.length) {
      await page
        .evaluate((entries) => {
          for (const { name, value } of entries) {
            try {
              localStorage.setItem(name, value);
            } catch {
              /* sandboxed */
            }
          }
        }, matchingOrigin.localStorage)
        .catch(() => {});
    }

    // Registered before the reload below so it actually fires on that load.
    await restoreSessionStorage(page.context(), join(ctx.sessionsDir, ctx.sessionId), page.url());
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

/**
 * Playwright's storageState covers cookies/localStorage but not sessionStorage — many SPAs
 * (this session's own target included, per the "auth stored in localStorage/sessionStorage"
 * finding) keep auth there too, so a fresh context restored from storageState alone can still
 * land unauthenticated. Replays saved sessionStorage entries via an init script instead.
 */
export async function restoreSessionStorage(
  context: BrowserContext,
  sessionDir: string,
  targetUrl: string,
): Promise<void> {
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

/**
 * Best available label for an element in a finding: visible text, then aria-label, then
 * title, then the icon's own class name (many real-world action buttons are icon-only with
 * none of the above — e.g. a plain <button><i class="bi-pencil-fill"></i></button>). Used
 * to say exactly what was clicked in a finding's steps, instead of a generic "Click Edit"
 * that doesn't help someone reproduce it against the real page.
 */
export async function describeElement(el: Locator, index?: number): Promise<string> {
  // Collapse internal whitespace too, not just leading/trailing — an element whose text is
  // spread across nested child nodes (a common pattern: an icon/label pair, or a visible label
  // plus a hidden a11y hint sub-span) yields a textContent full of the original markup's
  // indentation and newlines verbatim, producing multi-line, unreadable labels in reports.
  const rawText = (await el.textContent().catch(() => '')) ?? '';
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (text) return text;

  const ariaLabel = await el.getAttribute('aria-label').catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const title = await el.getAttribute('title').catch(() => null);
  if (title?.trim()) return title.trim();

  // .getAttribute() auto-waits for the locator to resolve to an attached element — if this
  // element has no <i>/<svg> child at all, `.first()` matches nothing and the call blocks
  // for Playwright's full default actionability timeout (tens of seconds) before giving up.
  // describeElement() is called for every element with no text/aria-label/title, which on a
  // real page can be many — .count() first is a plain, non-waiting query, so skipping costs
  // nothing when there's genuinely no icon.
  const iconLocator = el.locator('i, svg').first();
  const iconClass =
    (await iconLocator.count().catch(() => 0)) > 0
      ? await iconLocator.getAttribute('class').catch(() => null)
      : null;
  if (iconClass?.trim()) return `icon:${iconClass.trim().split(/\s+/).slice(0, 2).join(' ')}`;

  return index !== undefined ? `unlabeled element #${index}` : 'unlabeled element';
}

/**
 * A best-effort stable identifier for an element, for cross-flow finding dedup — NOT a
 * literal CSS selector you could re-query with, just something that tends to stay the same
 * across the same page when the same element is hit from different flows (id, then
 * data-testid/data-test, then name, then a tag+text+sibling-index fallback for elements with
 * none of those). Pairs with a finding's `pageUrl` so the report can merge two findings on
 * "same page + same element" — a stronger root-cause signal than title-text similarity.
 */
export async function elementFingerprint(el: Locator): Promise<string | null> {
  return el
    .evaluate((node) => {
      const e = node as HTMLElement;
      if (e.id) return `#${e.id}`;
      const testId = e.getAttribute('data-testid') || e.getAttribute('data-test');
      if (testId) return `[data-testid=${testId}]`;
      const name = e.getAttribute('name');
      if (name) return `${e.tagName.toLowerCase()}[name=${name}]`;
      const text = (e.innerText || e.textContent || '').trim().slice(0, 40);
      const parent = e.parentElement;
      const idx = parent
        ? Array.from(parent.children).filter((c) => c.tagName === e.tagName).indexOf(e)
        : 0;
      return `${e.tagName.toLowerCase()}:${idx}:${text}`;
    })
    .catch(() => null);
}

/**
 * How much breadth an exploration pass should use, scaled by session depth — a smoke run
 * samples a little, a deep run sweeps much further. Shared across journey.ts (modules to
 * explore), navigation.ts (pages/links to crawl), and action-inventory.ts (candidates per
 * page) so "explore more thoroughly" is one lever, not a separately-tuned constant per flow.
 */
export function explorationBreadth(
  ctx: ExecutorContext,
  tiers: { smoke: number; standard: number; deep: number; chaos: number },
): number {
  switch (ctx.config.depth) {
    case 'smoke':
      return tiers.smoke;
    case 'deep':
      return tiers.deep;
    case 'chaos':
      return tiers.chaos;
    case 'standard':
    default:
      return tiers.standard;
  }
}

/**
 * True if a button/link label implies a real external effect (payment, sending a
 * communication, publishing, deleting/destroying a resource, etc.) per site-policies.md —
 * these require consent before acting. Shared between journey.ts's gateIfSensitive (which
 * asks for consent before proceeding) and any broad exploratory pass that should just skip
 * risky-looking actions outright rather than trying to gate each one individually.
 */
export function isRiskyActionLabel(buttonLabel: string): boolean {
  const label = buttonLabel.toLowerCase();
  return (
    /\bsend\b/.test(label) ||
    /\bshare\b/.test(label) ||
    /\binvite\b/.test(label) ||
    /\bwhatsapp\b/.test(label) ||
    /\bsms\b/.test(label) ||
    /\bemail\b/.test(label) ||
    /\bnotif(y|ication)\b/.test(label) ||
    /\bmessage\b/.test(label) ||
    /\bforward\b/.test(label) ||
    // Per site-policies.md: social "compose" and blog-cms "Publish" both require
    // consent before the content actually goes out.
    /\bpost\b/.test(label) ||
    /\bpublish\b/.test(label) ||
    /\btweet\b/.test(label) ||
    /\bsubmit.*order\b/.test(label) ||
    /\bplace.*order\b/.test(label) ||
    /\bpay\b/.test(label) ||
    /\btransfer\b/.test(label) ||
    // Per site-policies.md: saas-dashboard/generic both require consent before
    // destructive resource actions (Delete project/user, Destroy resource).
    /\bdelete\b/.test(label) ||
    /\bdestroy\b/.test(label) ||
    /\bremove\b/.test(label) ||
    // Broad exploratory clicking (action-inventory.ts) additionally treats logout/sign-out
    // as risky to skip — gateIfSensitive doesn't, since journeys sometimes intentionally
    // test logout, but a generic sweep shouldn't end the session as a side effect.
    /\blogout\b/.test(label) ||
    /\bsign ?out\b/.test(label)
  );
}

/**
 * Returns true if the current page looks like a login/auth wall.
 * Only counts *visible* password / OTP fields so hidden template fields
 * don't false-positive. Used to suppress false findings on real login pages.
 */
export async function isLoginWallPage(page: Page): Promise<boolean> {
  const password = page.locator('input[type="password"]');
  const pwCount = await password.count();
  for (let i = 0; i < pwCount; i++) {
    if (await password.nth(i).isVisible().catch(() => false)) return true;
  }

  const otp = page.locator(
    'input[autocomplete="one-time-code"], input[maxlength="6"][type="text"]',
  );
  const otpCount = await otp.count();
  for (let i = 0; i < otpCount; i++) {
    if (await otp.nth(i).isVisible().catch(() => false)) return true;
  }

  // Segmented OTP entry (one input per digit, e.g. 6x `maxlength="1"` boxes with no
  // name/id/placeholder to identify them) — a very common pattern that the single-field
  // check above can't see at all.
  const segmentedOtp = page.locator('input[maxlength="1"]');
  const segmentedCount = await segmentedOtp.count().catch(() => 0);
  if (segmentedCount >= 4) {
    for (let i = 0; i < segmentedCount; i++) {
      if (await segmentedOtp.nth(i).isVisible().catch(() => false)) return true;
    }
  }

  // Phone-first login step (common in OTP-based consumer/fintech apps): a visible
  // phone/mobile input paired with a login-ish submit control, before any OTP field
  // has even appeared yet. Requires the paired button so a random phone field
  // elsewhere in the app (e.g. a profile form) doesn't false-positive.
  const phone = page.locator(
    'input[type="tel"], input[name*="phone" i], input[name*="mobile" i], ' +
      'input[placeholder*="phone" i], input[placeholder*="mobile" i]',
  );
  const phoneCount = await phone.count();
  let hasVisiblePhone = false;
  for (let i = 0; i < phoneCount; i++) {
    if (await phone.nth(i).isVisible().catch(() => false)) {
      hasVisiblePhone = true;
      break;
    }
  }
  if (hasVisiblePhone) {
    const loginBtn = page.locator(
      'button:has-text("Continue"), button:has-text("Log in"), button:has-text("Sign in"), ' +
        'button:has-text("Login"), button:has-text("Get OTP"), button:has-text("Send OTP"), button[type="submit"]',
    );
    if ((await loginBtn.count()) > 0) return true;
  }

  return false;
}

/**
 * After a form action, wait briefly then scan ALL elements matching
 * common validation-message selectors and return the first one that
 * has non-empty visible text.
 *
 * This avoids the false-positive caused by `.first()` picking up
 * permanently-present but empty error containers (e.g. Sauce Demo's
 * `<div class="error-message-container">` which is always in the DOM).
 */
export async function findVisibleErrorText(
  page: Page,
  waitMs = 600,
): Promise<string | null> {
  await page.waitForTimeout(waitMs);

  // Prioritise specific data-test selectors (app-defined) over generic class matches
  const ORDERED_SELECTORS = [
    '[data-test*="error"]',
    '[data-testid*="error"]',
    '[data-test*="alert"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-invalid="true"] + *',
    '.invalid-feedback',
    '.mat-error',
    '.v-messages',
    '[class*="field-error"]',
    '[class*="form-error"]',
    '[class*="validation"]',
  ];

  // A real error message always has at least one letter and more than a couple of
  // characters — a bare "*" (a required-field marker, extremely common inside the exact
  // kind of [class*="validation"]/[role="alert"] container this function matches) passes
  // a plain `length > 0` check but conveys no actual error content on its own, and was
  // exactly what produced a false "error message on page" finding on a real site.
  const looksLikeRealMessage = (text: string): boolean => text.length > 2 && /[a-zA-Z]/.test(text);

  for (const sel of ORDERED_SELECTORS) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await el.textContent().catch(() => null))?.trim();
      if (text && looksLikeRealMessage(text)) return text;
    }
  }

  // Final fallback: any element with class containing "error" that has text
  const fallbacks = await page.locator('[class*="error"]').all();
  for (const el of fallbacks) {
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.textContent().catch(() => null))?.trim();
    if (text && looksLikeRealMessage(text)) return text;
  }

  return null;
}

/**
 * Fills an OTP code into whichever entry pattern the page actually uses. Many real sites
 * (this one included) render OTP entry as N separate single-character boxes
 * (`maxlength="1"`, no name/id/placeholder to identify them individually) rather than one
 * field — every OTP selector elsewhere in this codebase is name/id/placeholder/autocomplete
 * based and silently matches nothing on that pattern, so a correct code still never gets
 * typed in. Falls back to a single combined field for sites that use one.
 */
export async function fillOtpInput(page: Page, otp: string): Promise<boolean> {
  const segmented = page.locator('input[maxlength="1"]:visible');
  // Retry briefly rather than a single instant count() — a page picked back up after a
  // pause (e.g. resuming a login that's been sitting on the OTP screen) can have this row
  // mid-re-render for a moment, and a same-tick check can miss boxes that are genuinely
  // there a few hundred ms later.
  let segCount = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    segCount = await segmented.count().catch(() => 0);
    if (segCount >= otp.length) break;
    await page.waitForTimeout(400);
  }
  if (segCount >= otp.length) {
    for (let i = 0; i < otp.length; i++) {
      await segmented.nth(i).fill(otp[i]).catch(() => {});
    }
    return true;
  }

  const single = page.locator(
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], ' +
      'input[name*="code" i], input[id*="code" i], input[placeholder*="otp" i], input[placeholder*="code" i]',
  ).first();
  if ((await single.count().catch(() => 0)) > 0 && (await single.isVisible().catch(() => false))) {
    await single.fill(otp);
    return true;
  }

  return false;
}
