import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage, findVisibleErrorText } from './helpers.js';

const BOUNDARY_INPUTS = ['', ' ', 'a', 'x'.repeat(500), '<script>alert(1)</script>', '🎉测试'];

/**
 * Classify whether an input field could trigger an external communication
 * (email, SMS, WhatsApp, etc.) if filled with random data.
 *
 * Returns:
 *   'high-risk'  — could send a real message/link to someone; NEVER use random data
 *   'sensitive'  — PII that belongs to a real person; ask user for real value
 *   'safe'       — generic test field; random/placeholder data is fine
 */
export type InputRisk = 'high-risk' | 'sensitive' | 'safe';

export function classifyInputRisk(
  name: string,
  placeholder: string,
  label: string,
  inputType: string,
): InputRisk {
  const text = `${name} ${placeholder} ${label}`.toLowerCase();

  // HIGH-RISK: filling these could trigger an actual message/email/notification to a real person
  const highRiskPatterns = [
    /recipient/i, /send to/i, /to:/i,
    /whatsapp/i, /telegram/i,
    /mobile.*number/i, /phone.*number/i, /contact.*number/i,
    /sms/i, /notify/i,
    /invite.*email/i, /share.*email/i, /email.*recipient/i,
    /message.*to/i, /subject/i,
  ];
  if (highRiskPatterns.some((p) => p.test(text)) || inputType === 'tel') {
    return 'high-risk';
  }

  // SENSITIVE: PII — should use real user-provided data, not random values
  const sensitivePatterns = [
    /\bemail\b/i, /\bphone\b/i, /\bmobile\b/i,
    /\baddress\b/i, /\bpostcode\b/i, /\bzip\b/i, /\bpincode\b/i,
    /\bcard\b/i, /\bcvv\b/i, /\biban\b/i, /\bbank\b/i, /\baccount.*no/i,
    /\bdob\b/i, /\bbirthday\b/i, /\baadhar\b/i, /\bpassport\b/i, /\bpan\b/i,
  ];
  if (sensitivePatterns.some((p) => p.test(text)) || inputType === 'email') {
    return 'sensitive';
  }

  return 'safe';
}

// Selectors that indicate visible validation feedback.
// Covers: CSS class conventions, ARIA roles, data-test attributes (e.g. Sauce Demo),
// and common framework patterns (Bootstrap, Material, Tailwind, custom).
const VALIDATION_SELECTORS = [
  // Class-based
  '[class*="error"]',
  '[class*="invalid"]',
  '[class*="validation"]',
  '[class*="field-error"]',
  '[class*="form-error"]',
  '[class*="alert"]',
  // ARIA
  '[role="alert"]',
  '[role="status"]',
  '[aria-invalid="true"]',
  '[aria-live]',
  // data-test / data-testid (e.g. Sauce Demo uses data-test="error")
  '[data-test*="error"]',
  '[data-testid*="error"]',
  '[data-test*="alert"]',
  '[data-testid*="alert"]',
  '[data-test*="message"]',
  // Framework-specific
  '.invalid-feedback',    // Bootstrap
  '.v-messages',          // Vuetify
  '.mat-error',           // Angular Material
  '.field-error',
  '[data-error]',
].join(', ');

export async function runFormValidation(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  // Skip form validation checks on pure login/auth-wall pages — those are
  // not application forms being tested, they're the auth gate itself.
  if (await isLoginWallPage(page)) {
    ctx.onLog('[Forms] Login wall detected — skipping generic form validation (handled by auth-portal journey)');
    return;
  }

  const forms = await page.locator('form').all();
  if (forms.length === 0) {
    ctx.onLog('[Forms] No forms found');
    return;
  }

  // Only test the first form to avoid duplicate findings across repeated flows.
  const form = forms[0];
  const inputs = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
  const count = await inputs.count();

  // Track forms already reported to avoid duplicate findings for the same form.
  const reportedForms = new Set<string>();

  for (let i = 0; i < Math.min(count, 2); i++) {
    const input = inputs.nth(i);
    const inputType = (await input.getAttribute('type')) ?? 'text';
    if (['checkbox', 'radio', 'file'].includes(inputType)) continue;

    // Classify the field before touching it
    const fieldName = (await input.getAttribute('name')) ?? '';
    const fieldPlaceholder = (await input.getAttribute('placeholder')) ?? '';
    const fieldId = (await input.getAttribute('id')) ?? '';
    // .textContent() auto-waits for the locator to resolve to an attached element — if no
    // <label for="..."> exists at all (very common; many real forms label via placeholder/
    // aria-label only), .first() on that zero-match locator would otherwise block for
    // Playwright's full default actionability timeout before the .catch() ever fires,
    // for every single field checked. .count() first is a plain, non-waiting query.
    const labelLocator = fieldId ? page.locator(`label[for="${fieldId}"]`).first() : null;
    const fieldLabel =
      labelLocator && (await labelLocator.count().catch(() => 0)) > 0
        ? ((await labelLocator.textContent().catch(() => '')) ?? '')
        : '';
    const risk = classifyInputRisk(fieldName, fieldPlaceholder, fieldLabel, inputType);

    if (risk === 'high-risk') {
      ctx.onLog(`[Forms] Field ${i} ("${fieldName || fieldPlaceholder}") is HIGH-RISK (could send real communication) — skipping random input`);
      continue;
    }
    if (risk === 'sensitive') {
      ctx.onLog(`[Forms] Field ${i} ("${fieldName || fieldPlaceholder}") is SENSITIVE PII — skipping random input, testing empty-submit only`);
      // Still test empty submission for required validation — just don't fill with random data
    }

    const hasRequired = (await input.getAttribute('required')) !== null;
    const hasAriaRequired = (await input.getAttribute('aria-required')) === 'true';
    const isRequired = hasRequired || hasAriaRequired;

    // Only test empty submission once per form
    const formKey = `form-${i}`;
    if (reportedForms.has(formKey)) continue;

    await input.fill('');
    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `form-${i}-empty.png`);
    await page.screenshot({ path: shot });

    const submit = form.locator('button[type="submit"], input[type="submit"]').first();
    if ((await submit.count()) === 0) continue;

    const urlBefore = page.url();

    // Listen for HTML5 native invalid event — fires when browser blocks submission
    const nativeValidationBlocked = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        const handler = () => { resolve(true); document.removeEventListener('invalid', handler, true); };
        document.addEventListener('invalid', handler, true);
        setTimeout(() => resolve(false), 200);
      });
    });

    await submit.click().catch(() => {});
    // Wait long enough for async validation + toast animations
    const errorText = await findVisibleErrorText(page, 800);

    const urlAfter = page.url();
    const navigatedAway = urlAfter !== urlBefore;

    if (nativeValidationBlocked) {
      ctx.onLog(`[Forms] Field ${i}: native HTML5 required validation active — OK`);
      reportedForms.add(formKey);
      continue;
    }

    if (navigatedAway) {
      ctx.onLog(`[Forms] Field ${i}: form navigated to "${urlAfter}" — checking for error page`);
      await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
      reportedForms.add(formKey);
      continue;
    }

    const hasInvalidPseudo = await page.evaluate(() =>
      document.querySelectorAll('input:invalid, select:invalid, textarea:invalid').length > 0,
    );

    if (errorText) {
      ctx.onLog(`[Forms] Field ${i}: validation message shown — "${errorText.slice(0, 80)}" — OK`);
    } else if (hasInvalidPseudo) {
      ctx.onLog(`[Forms] Field ${i}: :invalid pseudo-class active — OK`);
    } else if (isRequired) {
      ctx.onLog(`[Forms] Field ${i}: has required attribute, native tooltip expected`);
    } else {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Forms',
        title: `Empty submission accepted without validation on field ${i}`,
        steps: ['Clear field', 'Click Submit', 'Wait 800ms for validation'],
        expected: 'Validation error or required attribute on field',
        actual: 'No visible error message, no :invalid state, no required attribute',
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }

    reportedForms.add(formKey);
  }
}
