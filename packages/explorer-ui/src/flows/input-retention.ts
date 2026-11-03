import type { Locator, Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { classifyInputRisk } from './forms.js';
import { elementFingerprint, isLoginWallPage } from './helpers.js';
import { sameOriginRoutes, snap } from './list-items.js';

// A19 — Input retention. Every existing form check asks whether VALIDATION fires; none asks the
// more basic question of whether the field keeps what the user typed. Broken controlled inputs
// (a React onChange wired to the wrong state key, a mask that eats characters, a field whose
// keystrokes land in a neighbouring field) silently lose data and only surface later as a
// confusing "X is required" error. This types a placeholder value the way a user would
// (key by key, not a programmatic fill), leaves the field, and reads every field back: the
// typed field must hold exactly what was typed, and no OTHER field may have changed.
//
// Never submits anything. Follows the same risk tiers as every other form flow: high-risk
// fields are never touched; sensitive (PII) fields are only filled with a value the user
// supplied in credentials.extras; everything else gets an obviously-fake placeholder.

const FIELD_SELECTOR =
  'input:not([type]):visible, input[type="text"]:visible, input[type="search"]:visible, ' +
  'input[type="email"]:visible, input[type="number"]:visible, input[type="url"]:visible, textarea:visible';

export interface RetentionResult {
  /** Fields that ended up holding a value after this check (typed or user-supplied). */
  filled: number;
  /** Visible, editable fields that were left empty because they were risky/sensitive with no supplied value. */
  skippedEmpty: number;
  issues: number;
}

interface FieldMeta {
  name: string;
  placeholder: string;
  label: string;
  type: string;
  readOnly: boolean;
  disabled: boolean;
  maxLength: number;
  inputMode: string;
}

async function meta(field: Locator): Promise<FieldMeta | null> {
  return field
    .evaluate((el) => {
      const i = el as HTMLInputElement;
      const id = i.id;
      const lbl =
        (id ? document.querySelector(`label[for="${id}"]`)?.textContent : null) ??
        i.closest('label')?.textContent ??
        i.getAttribute('aria-label') ??
        '';
      return {
        name: i.name || id || i.getAttribute('data-test') || '',
        placeholder: i.placeholder ?? '',
        label: lbl.trim(),
        type: (i.getAttribute('type') ?? 'text').toLowerCase(),
        readOnly: i.readOnly,
        disabled: i.disabled,
        maxLength: i.maxLength,
        inputMode: (i.getAttribute('inputmode') ?? '').toLowerCase(),
      };
    })
    .catch(() => null);
}

function describe(m: FieldMeta): string {
  return m.label || m.placeholder || m.name || `${m.type} field`;
}

/** Value from credentials.extras whose key appears in the field's name/label/placeholder. */
function suppliedValue(ctx: ExecutorContext, m: FieldMeta): string | null {
  const extras = ctx.config.credentials?.extras ?? {};
  const text = `${m.name} ${m.label} ${m.placeholder}`.toLowerCase();
  for (const [k, v] of Object.entries(extras)) {
    if (k.startsWith('_') || !v) continue;
    if (text.includes(k.toLowerCase())) return v;
  }
  return null;
}

// Fields meant for numbers only (amount, price, quantity…) usually drop letters as you type —
// on purpose. Typing "QA Retain A0" into them and reading back "" is input filtering, not data
// loss, so they get digits instead.
const NUMERIC_FIELD = /\b(amount|price|cost|fee|qty|quantity|count|number|no\.?|age|pin|zip|postal|postcode|otp|mobile|phone|percent|rate|salary|total)\b/i;

function isNumericField(m: FieldMeta): boolean {
  if (m.type === 'number' || m.type === 'tel') return true;
  if (['numeric', 'decimal', 'tel'].includes(m.inputMode)) return true;
  return NUMERIC_FIELD.test(`${m.label} ${m.placeholder} ${m.name}`);
}

function placeholderFor(m: FieldMeta, n: number): string {
  if (isNumericField(m)) return String(40 + n);
  if (m.type === 'url') return `https://example.com/qa${n}`;
  const v = `QA Retain ${String.fromCharCode(65 + (n % 26))}${n}`;
  return m.maxLength > 0 ? v.slice(0, m.maxLength) : v;
}

async function readAll(fields: Locator): Promise<string[]> {
  return fields.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => []);
}

/**
 * Runs the retention check on every eligible field inside `scope` (default: whole page).
 * Exported so cart-integrity can reuse it on a checkout form.
 */
export async function checkFieldRetention(
  page: Page,
  ctx: ExecutorContext,
  opts: { scope?: Locator; maxFields?: number; restore?: boolean; tag?: string } = {},
): Promise<RetentionResult> {
  const root = opts.scope ?? page.locator('body');
  const fields = root.locator(FIELD_SELECTOR);
  const count = Math.min(await fields.count().catch(() => 0), opts.maxFields ?? 8);
  const result: RetentionResult = { filled: 0, skippedEmpty: 0, issues: 0 };
  const tag = opts.tag ?? 'InputRetention';

  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    const m = await meta(field);
    if (!m || m.readOnly || m.disabled) continue;

    const risk = classifyInputRisk(m.name, m.placeholder, m.label, m.type);
    let value: string | null;
    if (risk === 'high-risk') {
      ctx.onLog(`[${tag}] Skipping high-risk field "${describe(m)}"`);
      value = null;
    } else if (risk === 'sensitive' || m.type === 'email') {
      value = suppliedValue(ctx, m);
      if (!value) ctx.onLog(`[${tag}] Sensitive field "${describe(m)}" left alone — no value supplied in extras`);
    } else {
      value = placeholderFor(m, i);
    }
    if (value === null) {
      if (!(await field.inputValue().catch(() => ''))) result.skippedEmpty++;
      continue;
    }

    const before = await readAll(fields);
    const original = before[i] ?? '';
    await field.click({ timeout: 3000 }).catch(() => {});
    await field.fill('').catch(() => {});
    // Key-by-key on purpose: per-keystroke handlers are exactly where retention bugs live, and a
    // programmatic fill() can bypass them.
    await field.pressSequentially(value, { delay: 15, timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(300);

    const after = await readAll(fields);
    const kept = after[i] ?? '';
    const bled = after
      .map((v, j) => ({ j, from: before[j] ?? '', to: v }))
      .filter((d) => d.j !== i && d.from !== d.to);

    // One finding per field, covering both symptoms: a field that loses its value and a
    // neighbouring field that changes instead are usually the same broken handler (SauceDemo's
    // Last Name writes into First Name) — reporting them separately read as two bugs.
    let lost = kept !== value;
    if (lost && bled.length === 0 && /[^\d.]/.test(value)) {
      // Maybe the field only accepts digits and filtered the letters out. Try digits once:
      // if those stay, the field works — it was just rejecting characters it doesn't allow.
      const digits = String(40 + i);
      await field.fill('').catch(() => {});
      await field.pressSequentially(digits, { delay: 15, timeout: 8000 }).catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(300);
      const keptDigits = await field.inputValue().catch(() => '');
      if (keptDigits === digits) {
        ctx.onLog(`[${tag}] "${describe(m)}" only accepts numbers — letters are filtered on purpose, digits are kept`);
        lost = false;
      }
    }
    if (lost || bled.length > 0) {
      const otherNames: string[] = [];
      for (const d of bled.slice(0, 3)) {
        const om = await meta(fields.nth(d.j));
        otherNames.push(`"${om ? describe(om) : `field ${d.j + 1}`}" changed from "${d.from}" to "${d.to}"`);
      }
      result.issues++;
      const parts = [
        lost ? (kept ? `"${describe(m)}" holds "${kept}" instead` : `"${describe(m)}" is empty afterwards`) : '',
        bled.length > 0 ? `meanwhile ${otherNames.join('; ')}` : '',
      ].filter(Boolean);
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-InputRetention',
        title: lost
          ? `Field "${describe(m)}" does not keep the value typed into it${bled.length > 0 ? ' (the text goes to another field)' : ''}`
          : `Typing into "${describe(m)}" changes a different field`,
        steps: [`Open ${page.url()}`, `Type "${value}" into "${describe(m)}"`, 'Move focus to the next field', 'Read every field back'],
        expected: `"${describe(m)}" holds "${value}" and no other field changes`,
        actual: parts.join('; '),
        evidence: await snap(page, ctx, 'input-retention'),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url().split('#')[0],
        targetSelector: (await elementFingerprint(field)) ?? undefined,
        confidence: 'verified',
        confidenceReason: 'Reads every input element\'s own value before and after typing — an objective DOM fact.',
      });
    }
    if (!lost && bled.length === 0) ctx.onLog(`[${tag}] "${describe(m)}" kept its value`);

    if (opts.restore !== false) {
      await field.fill(original).catch(() => {});
    } else if (await field.inputValue().catch(() => '')) {
      result.filled++;
    }
  }
  return result;
}

export async function runInputRetention(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const pages = [page.url(), ...sameOriginRoutes(ctx, page.url(), 5)];
  let checkedPages = 0;
  for (const url of pages) {
    if (url !== page.url()) {
      const ok = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(500);
    }
    if (await isLoginWallPage(page)) continue;
    const hasFields = (await page.locator(FIELD_SELECTOR).count().catch(() => 0)) > 0;
    if (!hasFields) continue;
    checkedPages++;
    ctx.onLog(`[InputRetention] Checking fields on ${page.url()}`);
    await checkFieldRetention(page, ctx);
    if (checkedPages >= 3) break;
  }
  if (checkedPages === 0) ctx.onLog('[InputRetention] No editable fields found on the pages visited');
}
