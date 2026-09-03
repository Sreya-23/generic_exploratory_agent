import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// A single unbroken 300-char token — no spaces means it can't wrap, exposing containers with
// no overflow/word-break handling. Ordinary long sentences wrap and rarely break layout;
// this is the actual worst case (a long username, URL, or ID pasted into a field).
const LONG_TOKEN = 'A'.repeat(300);

export async function runLongContentStress(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[LongContent] Stress-testing text fields with an extremely long unbroken string');

  // Every common single-line text-entry type, not just the narrow "text/search" default —
  // tel/number/email/password/url fields are exactly as prone to overflow with a long value,
  // and are common on real forms (phone numbers, emails) that "text" alone misses entirely.
  const fields = page.locator(
    'input[type="text"], input[type="search"], input[type="tel"], input[type="number"], ' +
      'input[type="email"], input[type="password"], input[type="url"], input:not([type]), textarea',
  );
  const count = Math.min(await fields.count().catch(() => 0), 5);
  if (count === 0) {
    ctx.onLog('[LongContent] No text fields found');
    return;
  }

  const before = await page.evaluate(() => document.documentElement.scrollWidth);

  let filled = 0;
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    try {
      if (!(await field.isVisible({ timeout: 500 }))) continue;
      await field.fill(LONG_TOKEN, { timeout: 2000 });
      filled++;
    } catch {
      // readonly, custom widget, or otherwise unfillable — skip it
    }
  }
  if (filled === 0) {
    ctx.onLog('[LongContent] No fillable text fields found');
    return;
  }

  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.documentElement.scrollWidth);

  const overflowedFields = await page
    .evaluate((token) => {
      const marker = token.slice(0, 20);
      const candidates = Array.from(document.querySelectorAll('input, textarea'));
      const overflowed: string[] = [];
      for (const el of candidates) {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        if (!input.value?.includes(marker)) continue;
        const rect = input.getBoundingClientRect();
        const parent = input.parentElement;
        if (!parent) continue;
        const pRect = parent.getBoundingClientRect();
        if (rect.right > pRect.right + 5 || rect.width > pRect.width + 5) {
          overflowed.push(input.tagName.toLowerCase() + (input.name ? `[name="${input.name}"]` : ''));
        }
      }
      return overflowed;
    }, LONG_TOKEN)
    .catch(() => [] as string[]);

  const pageOverflowed = after > before + 20;
  if (!pageOverflowed && overflowedFields.length === 0) {
    ctx.onLog('[LongContent] Layout held up under long unbroken input');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'long-content.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'UI-LongContent',
    title: pageOverflowed
      ? 'Page layout breaks with an extremely long, unbroken text value'
      : `${overflowedFields.length} field container(s) overflow with long text`,
    steps: [
      `Enter a 300-character unbroken string (e.g. "${LONG_TOKEN.slice(0, 20)}...") into a text field`,
      'Observe the surrounding layout',
    ],
    expected: 'Long values wrap, truncate, or scroll within their own container without breaking the page layout',
    actual: pageOverflowed
      ? `Page scrollWidth grew from ${before}px to ${after}px after filling long content`
      : `Overflowing containers: ${overflowedFields.join(', ')}`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
    pageUrl: page.url(),
  });
}
