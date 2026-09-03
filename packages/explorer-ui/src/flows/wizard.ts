// A13 — Multi-step wizard: skip step via URL, back on step 3, progress persistence
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runWizard(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Wizard] Testing multi-step wizard flows');

  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `wizard-${name}.png`);

  // Detect wizard/stepper patterns
  const wizardSelectors = [
    '[class*="wizard"]',
    '[class*="stepper"]',
    '[class*="step-indicator"]',
    '[aria-label*="step" i]',
    '[data-step]',
    '[class*="multi-step"]',
  ];

  let wizardFound = false;
  for (const sel of wizardSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      wizardFound = true;
      ctx.onLog(`[Wizard] Found wizard via: ${sel}`);
      break;
    }
  }

  if (!wizardFound) {
    ctx.onLog('[Wizard] No multi-step wizard found on current page');
    return;
  }

  const s1 = shot('initial-state');
  await page.screenshot({ path: s1 });

  // 1. Attempt to skip to step 3 via URL manipulation
  const currentUrl = page.url();
  const stepUrls = [
    currentUrl.replace(/step[=\/]1/i, 'step=3'),
    currentUrl.replace(/step[=\/]1/i, 'step/3'),
    `${currentUrl}?step=3`,
    `${currentUrl}&step=3`,
  ].filter((u) => u !== currentUrl);

  let skippedStep = false;
  for (const altUrl of stepUrls) {
    await page.goto(altUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(500);

    const stepContent = await page.locator('[data-step="3"], [class*="step-3"]').count();
    if (stepContent > 0) {
      skippedStep = true;
      const s2 = shot('skip-to-step3');
      await page.screenshot({ path: s2 });

      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Wizard',
        title: 'Wizard step skippable via URL manipulation',
        steps: ['Start wizard at step 1', `Navigate directly to ${altUrl}`, 'Observe step 3 content'],
        expected: 'Redirect back to step 1 or show error if skipping is not allowed',
        actual: 'Step 3 content shown without completing steps 1 and 2',
        evidence: [s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
      break;
    }

    // Back to start
    await page.goto(currentUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  if (!skippedStep) {
    ctx.onLog('[Wizard] URL skip attempt blocked — good');
  }

  // 2. Navigate forward, then use browser Back
  const nextBtn = page
    .locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed")')
    .first();

  if ((await nextBtn.count()) === 0) {
    ctx.onLog('[Wizard] No Next button found');
    return;
  }

  await nextBtn.click().catch(() => {});
  await page.waitForTimeout(600);
  const s3 = shot('step-2');
  await page.screenshot({ path: s3 });

  // Click Next again to reach step 3
  if ((await nextBtn.count()) > 0) {
    await nextBtn.click().catch(() => {});
    await page.waitForTimeout(600);
    const s4 = shot('step-3');
    await page.screenshot({ path: s4 });

    // Use browser Back button
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(400);
    const s5 = shot('after-back');
    await page.screenshot({ path: s5 });

    // Check if data entered in previous step is still there. .count() first avoids the same
    // actionability-wait hang as elsewhere in this codebase when this step's page happens to
    // have no plain type="text" input at all (e.g. email/number/select-only steps).
    const textInput = page.locator('input[type="text"]').first();
    const inputValue =
      (await textInput.count().catch(() => 0)) > 0
        ? await textInput.inputValue().catch(() => null)
        : null;
    ctx.onLog(`[Wizard] After Back — first input value: "${inputValue}"`);

    if (inputValue === null || inputValue === '') {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Wizard',
        title: 'Form data lost when navigating back in multi-step wizard',
        steps: ['Fill step 1', 'Advance to step 3', 'Click browser Back'],
        expected: 'Previously entered data preserved when going back',
        actual: 'Input fields empty after browser Back',
        evidence: [s4, s5],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[Wizard] Data preserved after Back — good UX');
    }
  }
}
