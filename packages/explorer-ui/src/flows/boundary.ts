import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';
import { classifyInputRisk } from './forms.js';

/**
 * Checklist (UI) §3/§4 — boundary values, special characters, Unicode/emoji, leading/trailing
 * spaces. Previously this entire flow (`input-boundary`) was an 11-line pass-through that just
 * called `runFormValidation` again — functionally identical to the `form-validation` flow class,
 * testing nothing boundary-specific despite the name. A `BOUNDARY_INPUTS` constant already
 * existed in forms.ts for exactly this purpose but was never referenced anywhere.
 *
 * Only runs against the first SAFE-classified (per classifyInputRisk) text-like field on the
 * first form — same risk discipline as forms.ts, never fills a high-risk/sensitive field with
 * synthetic data.
 */
const BOUNDARY_CASES: Array<{ label: string; value: string }> = [
  { label: 'very long value (500 chars)', value: 'x'.repeat(500) },
  { label: 'leading/trailing spaces', value: '  padded value  ' },
  { label: 'unicode and emoji', value: '🎉测试 émoji ñ' },
  { label: 'special characters', value: '!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~' },
  { label: 'newline and tab characters', value: 'line1\nline2\ttabbed' },
];

// Tested separately via an actual submit (the cases above only fill+blur) since reflected XSS
// only shows up once the value round-trips through the app's own render path.
const XSS_PROBE_VALUE = '<script>alert("qa-boundary-xss")</script>';

export async function runInputBoundary(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[Boundary] Login wall detected — skipping boundary-value testing');
    return;
  }

  const forms = await page.locator('form').all();
  if (forms.length === 0) {
    ctx.onLog('[Boundary] No forms found');
    return;
  }
  const form = forms[0];
  const inputs = form.locator(
    'input:not([type="hidden"]):not([type="submit"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
  );
  const count = await inputs.count();
  if (count === 0) {
    ctx.onLog('[Boundary] No text-like fields found on the first form');
    return;
  }

  // Find the first SAFE field (same classification forms.ts already uses).
  let target = null;
  let targetIndex = -1;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const inputType = (await input.getAttribute('type')) ?? 'text';
    const fieldName = (await input.getAttribute('name')) ?? '';
    const fieldPlaceholder = (await input.getAttribute('placeholder')) ?? '';
    const fieldId = (await input.getAttribute('id')) ?? '';
    const labelLocator = fieldId ? page.locator(`label[for="${fieldId}"]`).first() : null;
    const fieldLabel =
      labelLocator && (await labelLocator.count().catch(() => 0)) > 0
        ? ((await labelLocator.textContent().catch(() => '')) ?? '')
        : '';
    const risk = classifyInputRisk(fieldName, fieldPlaceholder, fieldLabel, inputType);
    if (risk === 'safe') {
      target = input;
      targetIndex = i;
      break;
    }
  }
  if (!target) {
    ctx.onLog('[Boundary] No SAFE-classified field found — skipping to avoid filling sensitive/high-risk fields with synthetic data');
    return;
  }

  const originalValue = await target.inputValue().catch(() => '');

  // ── Fill+blur cases: check the field honestly reflects what was actually typed ───────────
  for (const bc of BOUNDARY_CASES) {
    try {
      await target.fill(bc.value);
      await target.blur();
      await page.waitForTimeout(150);
      const readBack = await target.inputValue();

      if (bc.label === 'leading/trailing spaces' && readBack === bc.value) {
        ctx.onLog(`[Boundary] Field ${targetIndex}: leading/trailing spaces preserved verbatim (not auto-trimmed) — informational, not necessarily a bug`);
      }
      if (bc.label.startsWith('very long value') && readBack.length < bc.value.length) {
        ctx.onLog(`[Boundary] Field ${targetIndex}: long value truncated to ${readBack.length} chars (likely a maxlength attribute) — OK, native browser behavior`);
      }
      if ((bc.label === 'unicode and emoji' || bc.label === 'special characters' || bc.label === 'newline and tab characters') && readBack !== bc.value && readBack.length > 0) {
        ctx.onLog(`[Boundary] Field ${targetIndex}: ${bc.label} was silently altered by the field (sent "${bc.value}", read back "${readBack}") — worth a manual look`);
      }
    } catch {
      /* field may have its own input mask/restrictions — not itself evidence of a bug */
    }
  }

  // ── Reflected-XSS probe: fill, submit, check the raw payload isn't echoed back unescaped ──
  // Complementary to the API-layer XSS check (injection.ts) — that one inspects raw HTTP
  // response text; this one goes through the real browser render path, catching cases where
  // the API response itself is safely escaped but client-side templating re-introduces the
  // vulnerability (e.g. an unescaped v-html/dangerouslySetInnerHTML downstream of a safe API).
  try {
    await target.fill(XSS_PROBE_VALUE);
    const submit = form.locator('button[type="submit"], input[type="submit"]').first();
    if ((await submit.count()) > 0) {
      const urlBefore = page.url();
      await submit.click().catch(() => {});
      await page.waitForTimeout(600);

      const bodyHtml = await page.content().catch(() => '');
      const reflectedUnescaped = bodyHtml.includes(XSS_PROBE_VALUE);

      if (reflectedUnescaped) {
        const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `boundary-xss-${targetIndex}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        ctx.onFinding({
          severity: 'high',
          area: 'UI-Forms',
          title: `Unescaped script tag reflected in the rendered page after form submission`,
          steps: [`Fill field ${targetIndex} with: ${XSS_PROBE_VALUE}`, 'Submit the form', 'Inspect the resulting page HTML'],
          expected: 'User-supplied input should be HTML-escaped before being rendered back into the page',
          actual: 'The raw, unescaped <script> tag appears verbatim in the rendered page HTML',
          evidence: [shot],
          reproRate: '1/1',
          automationCandidate: true,
          confidence: 'verified',
          confidenceReason: 'The exact literal payload string was found unescaped in the live rendered DOM, not inferred from a raw HTTP response.',
        });
      } else {
        ctx.onLog(`[Boundary] Field ${targetIndex}: XSS probe value was not reflected unescaped — OK`);
      }

      // Best-effort: return to the original page if the submit navigated away, so later
      // tasks in this session aren't left stranded on a confirmation/thank-you page.
      if (page.url() !== urlBefore) {
        await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } else {
      // No submit control reachable — restore the original value since nothing was submitted.
      await target.fill(originalValue).catch(() => {});
    }
  } catch {
    /* ignore — try the next task */
  }
}
