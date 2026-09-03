// I1/I2 — Business-logic boundary testing: negative/zero/oversized/decimal-precision
// values in amount/price/quantity-like fields. Deliberately never clicks submit — filling
// a payment-collection or similar form with a tampered value and actually submitting it
// could create a real artifact on a live system, which this agent's sensitive-action
// policy (site-policies.md) exists specifically to prevent. Inline validation feedback
// (an error message, aria-invalid, or a submit button that stays disabled) is checked
// entirely client-side, so a missing-validation finding here means "the browser accepted
// this without complaint" — server-side validation is explicitly left unverified in the
// finding text, since that would require the very submission this flow avoids.
import type { Locator, Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { explorationBreadth, findVisibleErrorText } from './helpers.js';

const AMOUNT_FIELD_PATTERN = /\b(amount|price|total|fee|quantity|qty|balance|value)\b/i;

interface AmountField {
  locator: Locator;
  label: string;
}

async function discoverAmountFields(page: Page): Promise<AmountField[]> {
  const fields: AmountField[] = [];
  const seen = new Set<string>();

  const candidates = page.locator('input[type="number"], input[type="text"]');
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    const type = (await el.getAttribute('type').catch(() => '')) ?? '';
    const name = (await el.getAttribute('name').catch(() => '')) ?? '';
    const id = (await el.getAttribute('id').catch(() => '')) ?? '';
    const placeholder = (await el.getAttribute('placeholder').catch(() => '')) ?? '';
    const ariaLabel = (await el.getAttribute('aria-label').catch(() => '')) ?? '';

    let labelText = '';
    if (id) {
      const lbl = page.locator(`label[for="${id}"]`).first();
      if ((await lbl.count().catch(() => 0)) > 0) {
        labelText = (await lbl.textContent().catch(() => '')) ?? '';
      }
    }

    const combined = `${name} ${id} ${placeholder} ${ariaLabel} ${labelText}`;
    const looksLikeAmount = type === 'number' || AMOUNT_FIELD_PATTERN.test(combined);
    if (!looksLikeAmount) continue;

    const key = name || id || placeholder || `idx:${i}`;
    if (seen.has(key)) continue;
    seen.add(key);

    fields.push({
      locator: el,
      label: labelText.trim() || placeholder || name || id || `field #${i}`,
    });
  }

  return fields;
}

const BOUNDARY_CASES: Array<{ value: string; label: string }> = [
  { value: '-100', label: 'a negative amount (-100)' },
  { value: '0', label: 'a zero amount' },
  { value: '999999999999', label: 'an extremely large amount (999999999999)' },
  { value: '0.001', label: 'sub-unit decimal precision (0.001)' },
];

export async function runBusinessLogicBoundary(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[BusinessLogic] Scanning for amount/price/quantity-like fields to boundary-test');

  const fields = await discoverAmountFields(page);
  if (fields.length === 0) {
    ctx.onLog('[BusinessLogic] No amount/price/quantity-like fields found on this page');
    return;
  }

  const maxFields = explorationBreadth(ctx, { smoke: 1, standard: 2, deep: 4, chaos: 1 });
  const testFields = fields.slice(0, maxFields);
  let flagged = 0;

  for (const field of testFields) {
    const original = await field.locator.inputValue().catch(() => '');

    for (const boundary of BOUNDARY_CASES) {
      await field.locator.fill(boundary.value).catch(() => {});
      await field.locator.blur().catch(() => {});
      await page.waitForTimeout(300);

      const errorText = await findVisibleErrorText(page, 200);
      const ariaInvalid = await field.locator.getAttribute('aria-invalid').catch(() => null);
      const hasInlineValidation = !!errorText || ariaInvalid === 'true';

      if (!hasInlineValidation) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-BusinessLogic',
          title: `"${field.label}" accepts ${boundary.label} with no client-side validation`,
          steps: [
            `Open ${page.url()}`,
            `Enter "${boundary.value}" into the "${field.label}" field`,
            'Move focus away (blur) without submitting',
            'Observe whether any validation error appears',
          ],
          expected: `An amount/price/quantity field should reject or flag ${boundary.label} before submission`,
          actual:
            `No inline validation error appeared after entering "${boundary.value}" into "${field.label}" — ` +
            `the value was accepted as-is. Submission was deliberately NOT attempted (would risk creating a ` +
            `real artifact on this live system), so server-side validation is unverified — worth a manual check.`,
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
        });
        flagged++;
      }
    }

    // Restore the field to what we found it as, so the page is left as-is for later flows.
    await field.locator.fill(original).catch(() => {});
  }

  ctx.onLog(
    `[BusinessLogic] Tested ${testFields.length} field(s) × ${BOUNDARY_CASES.length} boundary case(s) — ` +
      `${flagged} accepted without client-side validation`,
  );
}
