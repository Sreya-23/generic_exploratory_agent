/**
 * Shared helpers used across flow files.
 */
import type { Page } from 'playwright';

/**
 * Returns true if the current page looks like a login/auth wall.
 * Used to suppress false-positive findings (no nav, no links) on login pages.
 */
export async function isLoginWallPage(page: Page): Promise<boolean> {
  const pwCount = await page.locator('input[type="password"]').count();
  if (pwCount > 0) return true;

  // Also catch OTP-only walls (no password field but has a 6-digit code input)
  const otpInput = await page
    .locator('input[autocomplete="one-time-code"], input[maxlength="6"][type="text"]')
    .count();
  return otpInput > 0;
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

  for (const sel of ORDERED_SELECTORS) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await el.textContent().catch(() => null))?.trim();
      if (text && text.length > 0) return text;
    }
  }

  // Final fallback: any element with class containing "error" that has text
  const fallbacks = await page.locator('[class*="error"]').all();
  for (const el of fallbacks) {
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.textContent().catch(() => null))?.trim();
    if (text && text.length > 0) return text;
  }

  return null;
}
