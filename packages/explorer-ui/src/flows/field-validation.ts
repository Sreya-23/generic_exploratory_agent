import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

/**
 * Checklist (UI) §4 — Field Validation depth: numeric/date/email-format bounds, password rules,
 * cross-field/confirm-password matching, and validation timing (on-blur vs on-submit). Distinct
 * from forms.ts (empty-submission only) and boundary.ts (generic boundary/special-char values
 * not tied to a specific field TYPE's own validation rules).
 *
 * Fill-and-blur only, never submits — testing format validation only needs the value to exist
 * long enough for the page's own validation logic to react; submitting isn't necessary and would
 * add risk for sensitive-classified fields (email/phone) with no additional test value. A
 * deliberately-malformed, non-deliverable string (e.g. "not-an-email") carries none of the risk
 * classifyInputRisk's "sensitive" tier exists to prevent (that risk is about a plausible-looking
 * FAKE value being submitted and stored as if real) — so this runs on sensitive-classified email/
 * phone/date fields too, just never on high-risk fields, and never via an actual submit.
 */

async function hasVisibleError(page: Page, field: ReturnType<Page['locator']>): Promise<boolean> {
  const nativeInvalid = await field.evaluate((el) => !(el as HTMLInputElement).validity.valid).catch(() => false);
  if (nativeInvalid) return true;
  const errorNearby = await page
    .locator('[class*="error"]:visible, [role="alert"]:visible, [aria-invalid="true"]')
    .count()
    .catch(() => 0);
  return errorNearby > 0;
}

export async function runFieldValidationCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[FieldValidation] Login wall detected — skipping');
    return;
  }

  const forms = await page.locator('form').all();
  if (forms.length === 0) {
    ctx.onLog('[FieldValidation] No forms found');
    return;
  }
  const form = forms[0];
  let count = 0;

  // ── Email format ──────────────────────────────────────────────────────────────────────────
  const emailField = form.locator('input[type="email"]').first();
  if ((await emailField.count()) > 0) {
    const original = await emailField.inputValue().catch(() => '');
    await emailField.fill('not-an-email');
    await emailField.blur();
    await page.waitForTimeout(200);
    if (!(await hasVisibleError(page, emailField))) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-FieldValidation',
        title: 'Email field accepts an obviously malformed value',
        steps: ['Fill an email-type field with "not-an-email"', 'Blur the field'],
        expected: 'An invalid email format should trigger :invalid state or a visible validation message',
        actual: 'No native invalid state and no visible error after entering a non-email string',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
      });
      count++;
    } else {
      ctx.onLog('[FieldValidation] Email format validation active — OK');
    }
    await emailField.fill(original).catch(() => {});
  }

  // ── Numeric min/max bounds (only when the field declares them) ──────────────────────────────
  const numberField = form.locator('input[type="number"]').first();
  if ((await numberField.count()) > 0) {
    const min = await numberField.getAttribute('min');
    const max = await numberField.getAttribute('max');
    const original = await numberField.inputValue().catch(() => '');
    if (min !== null) {
      const belowMin = String(Number(min) - 1);
      await numberField.fill(belowMin);
      await numberField.blur();
      await page.waitForTimeout(200);
      if (!(await hasVisibleError(page, numberField))) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-FieldValidation',
          title: `Numeric field accepts a value below its declared minimum (${min})`,
          steps: [`Fill a number field (min="${min}") with ${belowMin}`, 'Blur the field'],
          expected: 'A value below the declared minimum should trigger :invalid or a visible error',
          actual: 'No invalid state or error shown',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        count++;
      } else {
        ctx.onLog('[FieldValidation] Numeric min-bound validation active — OK');
      }
    }
    if (max !== null) {
      const aboveMax = String(Number(max) + 1);
      await numberField.fill(aboveMax);
      await numberField.blur();
      await page.waitForTimeout(200);
      if (!(await hasVisibleError(page, numberField))) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-FieldValidation',
          title: `Numeric field accepts a value above its declared maximum (${max})`,
          steps: [`Fill a number field (max="${max}") with ${aboveMax}`, 'Blur the field'],
          expected: 'A value above the declared maximum should trigger :invalid or a visible error',
          actual: 'No invalid state or error shown',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
        });
        count++;
      } else {
        ctx.onLog('[FieldValidation] Numeric max-bound validation active — OK');
      }
    }
    if (min === null && max === null) {
      ctx.onLog('[FieldValidation] Numeric field has no declared min/max — bounds check not applicable');
    }
    await numberField.fill(original).catch(() => {});
  }

  // ── Date format/range ─────────────────────────────────────────────────────────────────────
  const dateField = form.locator('input[type="date"]').first();
  if ((await dateField.count()) > 0) {
    const min = await dateField.getAttribute('min');
    const max = await dateField.getAttribute('max');
    const original = await dateField.inputValue().catch(() => '');
    if (min) {
      const beforeMin = new Date(min);
      beforeMin.setDate(beforeMin.getDate() - 1);
      await dateField.fill(beforeMin.toISOString().slice(0, 10)).catch(() => {});
      await dateField.blur();
      await page.waitForTimeout(200);
      if (!(await hasVisibleError(page, dateField))) {
        ctx.onLog(`[FieldValidation] Date field accepted a value before its declared minimum (${min}) — native date inputs often clamp silently rather than error, not flagged as a defect on its own`);
      } else {
        ctx.onLog('[FieldValidation] Date min-bound validation active — OK');
      }
    } else {
      ctx.onLog('[FieldValidation] Date field has no declared min — range check not applicable');
    }
    await dateField.fill(original).catch(() => {});
  }

  // ── Confirm-password mismatch ─────────────────────────────────────────────────────────────
  const passwordFields = await form.locator('input[type="password"]').all();
  if (passwordFields.length >= 2) {
    const [pw1, pw2] = passwordFields;
    const orig1 = await pw1.inputValue().catch(() => '');
    const orig2 = await pw2.inputValue().catch(() => '');
    await pw1.fill('QaTestPassword123!');
    await pw2.fill('QaDifferentPassword456!');
    await pw2.blur();
    await page.waitForTimeout(300);
    if (!(await hasVisibleError(page, pw2))) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-FieldValidation',
        title: 'Mismatched password/confirm-password fields show no validation error',
        steps: ['Fill the password field with one value', 'Fill the confirm-password field with a different value', 'Blur the confirm field'],
        expected: 'A mismatch between password and confirm-password should be flagged before submit',
        actual: 'No visible error after the two password fields disagree',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Assumes the second password field is specifically a "confirm password" field rather than an unrelated second password input — verify the field\'s purpose before treating as confirmed.',
      });
      count++;
    } else {
      ctx.onLog('[FieldValidation] Password-mismatch validation active — OK');
    }
    await pw1.fill(orig1).catch(() => {});
    await pw2.fill(orig2).catch(() => {});
  } else {
    ctx.onLog('[FieldValidation] Fewer than 2 password fields — confirm-password check not applicable');
  }

  // ── Validation timing: does an error show on blur, or only (if ever) on submit? ──────────
  // Uses the email field again if present, since it already has a known-invalid value pattern.
  if ((await emailField.count()) > 0) {
    const original = await emailField.inputValue().catch(() => '');
    await emailField.fill('x');
    await page.waitForTimeout(100);
    const errorWhileTyping = await hasVisibleError(page, emailField);
    await emailField.blur();
    await page.waitForTimeout(200);
    const errorOnBlur = await hasVisibleError(page, emailField);
    ctx.onLog(`[FieldValidation] Validation timing for email field: ${errorWhileTyping ? 'shows error while typing' : 'no error while typing'}, ${errorOnBlur ? 'shows error on blur' : 'no error on blur'} — both are valid UX choices, logged for reference only`);
    await emailField.fill(original).catch(() => {});
  }

  if (count === 0) {
    ctx.onLog('[FieldValidation] Field-type-specific validation checks passed (or not applicable) across all tested fields');
  }
}
