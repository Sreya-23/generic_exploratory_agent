import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { findVisibleErrorText } from './helpers.js';

async function shot(page: Page, ctx: ExecutorContext, label: string): Promise<string> {
  const p = join(
    ctx.sessionsDir,
    ctx.sessionId,
    'screenshots',
    `user-directed-${label.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.png`,
  );
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/**
 * Fill any form field whose label, placeholder, name, or aria-label matches the key.
 * Used to inject extras (phone, card, account number, etc.) into forms.
 */
export async function fillExtras(page: Page, extras: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(extras)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, ' ');

    // Try to find by label text, placeholder, name attribute, aria-label, id
    const locator = page
      .locator(
        `input[name*="${key}" i], input[placeholder*="${normalizedKey}" i], ` +
        `input[aria-label*="${normalizedKey}" i], input[id*="${key}" i], ` +
        `textarea[name*="${key}" i], textarea[placeholder*="${normalizedKey}" i]`,
      )
      .first();

    if (await locator.count() > 0) {
      await locator.fill(value).catch(() => {});
    }
  }
}

/**
 * Parse an instruction string into an action + target.
 * e.g. "test the payment flow" → { action: 'click', target: 'payment' }
 * e.g. "send link to +91 9876543210" → { action: 'fill', target: '+91 9876543210', field: 'phone' }
 */
interface ParsedInstruction {
  rawInstruction: string;
  action: 'click' | 'fill' | 'navigate' | 'observe';
  keywords: string[];
  fillValue?: string;
  fillField?: string;
}

function parseInstruction(instruction: string): ParsedInstruction {
  const lower = instruction.toLowerCase();

  // "send link to X" / "send to X" / "try with number X"
  const sendMatch = instruction.match(/send(?:\s+\w+)?\s+to\s+(.+)/i);
  if (sendMatch) {
    return {
      rawInstruction: instruction,
      action: 'fill',
      keywords: ['send', 'phone', 'mobile', 'number', 'recipient'],
      fillValue: sendMatch[1].trim(),
      fillField: 'phone',
    };
  }

  // "fill X with Y" / "enter Y in X"
  const fillMatch = instruction.match(/(?:fill|enter|input|type)\s+(.+?)\s+(?:with|in|into)\s+(.+)/i);
  if (fillMatch) {
    return {
      rawInstruction: instruction,
      action: 'fill',
      keywords: [fillMatch[1].trim()],
      fillValue: fillMatch[2].trim(),
      fillField: fillMatch[1].trim(),
    };
  }

  // Extract keywords from instruction for element matching
  const stopWords = new Set([
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'with',
    'test', 'try', 'check', 'explore', 'verify', 'run', 'focus', 'go', 'through',
  ]);
  const keywords = lower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  return {
    rawInstruction: instruction,
    action: 'click',
    keywords,
  };
}

/**
 * Try to find and interact with page elements matching the instruction keywords.
 */
async function followInstruction(
  page: Page,
  ctx: ExecutorContext,
  parsed: ParsedInstruction,
): Promise<void> {
  const { action, keywords, fillValue, fillField } = parsed;

  if (action === 'fill' && fillValue) {
    // Try to find a field matching fillField, then fall back to extras filling
    const fieldQuery = fillField
      ? `input[name*="${fillField}" i], input[placeholder*="${fillField}" i], ` +
        `input[aria-label*="${fillField}" i], input[type="tel"], input[type="phone"]`
      : 'input[type="tel"], input[name*="phone" i], input[name*="mobile" i]';

    const field = page.locator(fieldQuery).first();
    if (await field.count() > 0) {
      await field.fill(fillValue).catch(() => {});
      ctx.onLog(`[UserDirected] Filled "${fillField ?? 'field'}" with "${fillValue}"`);
    } else {
      ctx.onLog(`[UserDirected] Could not find field for: ${fillField ?? 'phone'}`);
    }

    // Also fill from extras if available
    const extras = ctx.config.credentials?.extras;
    if (extras) await fillExtras(page, extras);

    // Try to submit
    const submitBtn = page.locator('button[type="submit"], button:has-text("Send"), button:has-text("Submit")').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    return;
  }

  if (action === 'click') {
    // Build a selector that matches any of the keywords
    for (const keyword of keywords) {
      const btnLocator = page.locator(
        `button:has-text("${keyword}"), a:has-text("${keyword}"), [role="tab"]:has-text("${keyword}")`,
      ).first();

      if (await btnLocator.count() > 0) {
        const label = await btnLocator.textContent().catch(() => keyword);
        await btnLocator.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(500);
        ctx.onLog(`[UserDirected] Clicked: "${label?.trim()}"`);
        return;
      }

      // Try nav links
      const linkLocator = page.locator(`a:has-text("${keyword}")`).first();
      if (await linkLocator.count() > 0) {
        await linkLocator.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        ctx.onLog(`[UserDirected] Navigated via link: "${keyword}"`);
        return;
      }
    }

    ctx.onLog(`[UserDirected] No matching element found for keywords: ${keywords.join(', ')}`);
  }
}

export async function runUserDirectedFlow(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  const instruction = task.description ?? task.title;
  ctx.onLog(`[UserDirected] Following instruction: "${instruction}"`);

  // Pre-action gate for risky operations
  const lower = instruction.toLowerCase();
  const isRisky =
    /\bpay(ment|ing)?\b|\bpurchase\b|\bbuy\b|\bcheckout\b|\bsend.*link\b|\btransfer\b|\bbook.*confirm\b/.test(lower);

  if (isRisky && ctx.onPreActionNeeded) {
    const isPayment = /\bpay|\bpurchase\b|\bbuy\b|\bcheckout\b|\btransfer\b/.test(lower);
    const isSendLink = /\bsend.*link\b/.test(lower);

    const extras = ctx.onPreActionNeeded({
      type: isPayment ? 'purchase' : isSendLink ? 'send_link' : 'generic',
      description: `User-directed: "${instruction.slice(0, 80)}"`,
      requiredExtras: isPayment ? ['card'] : isSendLink ? ['phone'] : [],
      pageUrl: page.url(),
    });

    if (extras === null) {
      ctx.onLog(`[UserDirected] Skipped risky instruction — awaiting user confirmation`);
      return;
    }
  }

  const parsed = parseInstruction(instruction);
  const s1 = await shot(page, ctx, `before-${parsed.keywords[0] ?? 'start'}`);

  // Fill any extras into visible form fields first
  const extras = ctx.config.credentials?.extras;
  if (extras && Object.keys(extras).length > 0) {
    await fillExtras(page, extras);
    ctx.onLog(`[UserDirected] Pre-filled extras: ${Object.keys(extras).join(', ')}`);
  }

  await followInstruction(page, ctx, parsed);

  const s2 = await shot(page, ctx, `after-${parsed.keywords[0] ?? 'done'}`);
  ctx.onLog(`[UserDirected] Completed: "${instruction}" — now at ${page.url()}`);

  // Check for error states after the interaction. Uses the shared, visibility-checked
  // helper (not a raw `[class*="error"]` selector) — a naive .first() match can grab a
  // large wrapping container and report its entire concatenated text as "the error".
  const errorText = await findVisibleErrorText(page, 400);

  if (errorText) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-UserDirected',
      title: `Error after: "${instruction}"`,
      steps: [
        `Navigate to ${ctx.config.targetUrl}`,
        `Follow instruction: ${instruction}`,
        'Observe error message',
      ],
      expected: 'Flow completes without error',
      actual: `Error shown: "${errorText.trim().slice(0, 120)}"`,
      evidence: [s1, s2],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}
