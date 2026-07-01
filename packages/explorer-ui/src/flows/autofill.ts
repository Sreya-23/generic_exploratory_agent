// A10 — Copy/paste & autofill: browser autofill, masked fields, clipboard
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runAutofill(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Autofill] Testing paste, autofill, and masked field behaviour');

  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `autofill-${name}.png`);

  const form = page.locator('form').first();
  if ((await form.count()) === 0) {
    ctx.onLog('[Autofill] No form found');
    return;
  }

  // 1. Test paste into text inputs
  const textInput = form.locator('input[type="text"], input[type="email"]').first();
  if ((await textInput.count()) > 0) {
    // Simulate clipboard paste using keyboard shortcut approach
    await textInput.focus();
    await page.keyboard.insertText('pasted_value_test@example.com');
    await page.waitForTimeout(300);

    const pastedVal = await textInput.inputValue().catch(() => '');
    const s1 = shot('paste');
    await page.screenshot({ path: s1 });

    if (!pastedVal.includes('pasted_value_test')) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Autofill',
        title: 'Text input may be blocking paste/programmatic input',
        steps: ['Focus text input', 'Programmatically insert text', 'Read input value'],
        expected: 'Pasted value appears in input',
        actual: `Input value after paste: "${pastedVal}"`,
        evidence: [s1],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog('[Autofill] Paste works correctly in text input');
    }
  }

  // 2. Check password fields are masked (type="password")
  const passwordInputs = form.locator('input[type="password"]');
  const pwCount = await passwordInputs.count();
  if (pwCount > 0) {
    ctx.onLog(`[Autofill] Found ${pwCount} password field(s) — correctly masked`);
  }

  // 3. Check for inputs that look like passwords but aren't masked
  const suspiciousInputs = await page.$$eval('form input[type="text"]', (els) =>
    (els as HTMLInputElement[])
      .filter((el) => {
        const name = (el.name ?? '').toLowerCase();
        const placeholder = (el.placeholder ?? '').toLowerCase();
        return (
          name.includes('pass') ||
          name.includes('secret') ||
          name.includes('token') ||
          placeholder.includes('password')
        );
      })
      .map((el) => el.name || el.placeholder),
  );

  if (suspiciousInputs.length > 0) {
    const s2 = shot('unmasked-sensitive');
    await page.screenshot({ path: s2 });
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Autofill',
      title: `Sensitive field not masked: ${suspiciousInputs.join(', ')}`,
      steps: ['Inspect input fields for password-like names', 'Check type attribute'],
      expected: 'Password/secret fields use type="password"',
      actual: `Field(s) "${suspiciousInputs.join(', ')}" appear sensitive but use type="text"`,
      evidence: [s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  // 4. Test very long paste (boundary)
  if ((await textInput.count()) > 0) {
    const longValue = 'a'.repeat(10000);
    await textInput.fill('');
    await textInput.fill(longValue);
    const actualVal = await textInput.inputValue().catch(() => '');
    const s3 = shot('long-paste');
    await page.screenshot({ path: s3 });

    if (actualVal.length === 0) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-Autofill',
        title: 'Input field silently rejects very long pasted value',
        steps: ['Fill input with 10,000 character string'],
        expected: 'Field either accepts or shows maxlength error',
        actual: 'Field value is empty after attempting to fill 10k chars',
        evidence: [s3],
        reproRate: '1/1',
        automationCandidate: true,
      });
    } else {
      ctx.onLog(`[Autofill] Long value accepted — stored ${actualVal.length} chars`);
    }
  }
}
