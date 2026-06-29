import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const BOUNDARY_INPUTS = ['', ' ', 'a', 'x'.repeat(500), '<script>alert(1)</script>', '🎉测试'];

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
  const forms = await page.locator('form').all();
  if (forms.length === 0) {
    ctx.onLog('[Forms] No forms found');
    return;
  }

  const form = forms[0];
  const inputs = form.locator('input:not([type="hidden"]):not([type="submit"])');
  const count = await inputs.count();

  for (let i = 0; i < Math.min(count, 3); i++) {
    const input = inputs.nth(i);
    const inputType = (await input.getAttribute('type')) ?? 'text';

    if (['checkbox', 'radio', 'file'].includes(inputType)) continue;

    // Check if the field has a native required attribute
    const hasRequired = (await input.getAttribute('required')) !== null;
    const hasAriaRequired = (await input.getAttribute('aria-required')) === 'true';
    const isRequired = hasRequired || hasAriaRequired;

    for (const value of BOUNDARY_INPUTS.slice(0, 3)) {
      await input.fill(value);
      const shot = join(
        ctx.sessionsDir,
        ctx.sessionId,
        'screenshots',
        `form-${i}-${value.slice(0, 10).replace(/[^a-z0-9]/gi, '') || 'empty'}.png`,
      );
      await page.screenshot({ path: shot });

      if (value === '' || value === ' ') {
        const submit = form.locator('button[type="submit"], input[type="submit"]').first();
        if ((await submit.count()) === 0) continue;

        const urlBefore = page.url();

        // Listen for browser-native validation (invalid event fires when HTML5
        // required check blocks submission — this is NOT a bug)
        const nativeValidationBlocked = await page.evaluate(() => {
          return new Promise<boolean>((resolve) => {
            const handler = () => {
              resolve(true);
              document.removeEventListener('invalid', handler, true);
            };
            document.addEventListener('invalid', handler, true);
            // Resolve false after 200ms if no invalid event fires
            setTimeout(() => resolve(false), 200);
          });
        });

        await submit.click().catch(() => {});
        await page.waitForTimeout(600);

        const urlAfter = page.url();
        const navigatedAway = urlAfter !== urlBefore;

        // If browser native validation fired, the field is protected — not a bug
        if (nativeValidationBlocked) {
          ctx.onLog(`[Forms] Field ${i}: native HTML5 required validation active — OK`);
          continue;
        }

        // If we navigated away, the form submitted — check if it was an error page
        if (navigatedAway) {
          const status = await page.evaluate(() => document.title);
          ctx.onLog(`[Forms] Field ${i}: form submitted and navigated to "${status}"`);
          await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
          continue;
        }

        // Still on the same page — look for visible validation feedback
        const validationMsg = await page
          .locator(VALIDATION_SELECTORS)
          .first()
          .textContent()
          .catch(() => null);

        // Also check if any input now has :invalid pseudo-class styling
        const hasInvalidPseudo = await page.evaluate(() => {
          const invalids = document.querySelectorAll('input:invalid, select:invalid, textarea:invalid');
          return invalids.length > 0;
        });

        if (!isRequired && !validationMsg && !hasInvalidPseudo) {
          // Field not marked required AND no validation shown — genuine gap
          ctx.onFinding({
            severity: 'medium',
            area: 'UI-Forms',
            title: 'Empty form submission may be allowed without validation',
            steps: ['Clear required field', 'Submit form'],
            expected: 'Validation error shown',
            actual: 'No visible validation message and field lacks required attribute',
            evidence: [shot],
            reproRate: '1/1',
            automationCandidate: true,
          });
        } else if (validationMsg || hasInvalidPseudo) {
          ctx.onLog(`[Forms] Field ${i}: validation feedback detected — OK`);
        } else {
          // Has required but no visible message — may rely on native tooltip
          ctx.onLog(`[Forms] Field ${i}: has required attribute, native tooltip expected`);
        }
      }
    }
  }
}
