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

  // 0. Real browser autofill eligibility — the `autocomplete` attribute is literally the
  // mechanism that makes a field eligible for the browser's native autofill; a field that LOOKS
  // like a standard identity field (name/email/phone/address) but has no recognized autocomplete
  // token, or has it explicitly disabled, will never be offered real autofill by any browser,
  // regardless of what the site's own JS does. This is the directly-testable, reliable proxy for
  // "does browser autofill work here" — actually forcing Chromium's autofill engine to fire via
  // CDP requires simulating its internal heuristic-matching + suggestion-dropdown UI, which is
  // fragile and version-dependent enough to produce unreliable findings, so this checks the
  // precondition instead of attempting to force the real autofill popup.
  const AUTOFILL_FIELD_PATTERNS: Array<{ pattern: RegExp; expectedTokens: string[] }> = [
    { pattern: /email/i, expectedTokens: ['email'] },
    { pattern: /\b(first|given)[-_]?name\b/i, expectedTokens: ['given-name'] },
    { pattern: /\b(last|family|sur)[-_]?name\b/i, expectedTokens: ['family-name'] },
    { pattern: /\bfull[-_]?name\b|^name$/i, expectedTokens: ['name'] },
    { pattern: /\bphone|mobile|tel\b/i, expectedTokens: ['tel'] },
    { pattern: /\baddress\b/i, expectedTokens: ['street-address', 'address-line1'] },
    { pattern: /\bzip|postal|postcode\b/i, expectedTokens: ['postal-code'] },
    { pattern: /\bcity\b/i, expectedTokens: ['address-level2'] },
  ];
  const candidateFields = await page.$$eval(
    'form input[type="text"], form input[type="email"], form input[type="tel"], form input:not([type])',
    (els) => (els as HTMLInputElement[]).map((el) => ({
      name: el.name ?? '',
      placeholder: el.placeholder ?? '',
      id: el.id ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
    })),
  ).catch(() => []);
  const missingAutocomplete: string[] = [];
  for (const field of candidateFields) {
    const text = `${field.name} ${field.placeholder} ${field.id}`;
    const match = AUTOFILL_FIELD_PATTERNS.find((p) => p.pattern.test(text));
    if (!match) continue;
    const current = field.autocomplete.toLowerCase();
    const hasExpectedToken = match.expectedTokens.some((t) => current.includes(t));
    if (current === 'off' || (!hasExpectedToken && current !== 'on')) {
      missingAutocomplete.push(field.name || field.placeholder || field.id || '(unnamed field)');
    }
  }
  if (missingAutocomplete.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Autofill',
      title: `Field(s) look like standard identity fields but lack a proper autocomplete attribute: ${missingAutocomplete.join(', ')}`,
      steps: ['Inspect the field\'s name/placeholder/id to identify its purpose', 'Check its autocomplete attribute'],
      expected: 'A field recognizable as email/name/phone/address should carry the matching autocomplete token (e.g. autocomplete="email") so browsers can offer autofill',
      actual: `${missingAutocomplete.length} field(s) missing or have the wrong autocomplete token — real browser autofill will not work for these`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Field purpose is inferred from name/placeholder/id text, which could misclassify an unusually-named field — verify before treating as confirmed.',
    });
  } else if (candidateFields.length > 0) {
    ctx.onLog('[Autofill] All recognized identity-shaped fields carry an appropriate autocomplete attribute — real browser autofill should work');
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
