import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Leftover dev/placeholder text left in an actual placeholder attribute — the same class of
// "obviously fake" content visual-review.ts's Gemini prompt looks for on-screen, applied to
// the one place a plain DOM scan can check for it directly and cheaply.
const DEV_LEFTOVER_PATTERN = /lorem ipsum|^(todo|fixme|test|placeholder|xxx+|foo|bar|asdf)$/i;

export async function runPlaceholderCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Placeholder] Checking placeholder text quality and value/placeholder leakage');

  const { leaked, devLeftovers } = await page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const leaked: string[] = [];
    const devLeftovers: string[] = [];
    const fields = Array.from(
      document.querySelectorAll('input[placeholder], textarea[placeholder]'),
    ) as (HTMLInputElement | HTMLTextAreaElement)[];

    for (const el of fields) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const placeholder = el.getAttribute('placeholder')?.trim() ?? '';
      if (!placeholder) continue;

      const label = el.name || el.id || placeholder.slice(0, 30);

      // A field whose actual VALUE exactly matches its own placeholder text is a real,
      // classic bug — the placeholder should only ever be a hint shown when the field is
      // empty, never something that ends up submitted as real data.
      if (el.value && el.value === placeholder) {
        leaked.push(label);
      }

      if (re.test(placeholder)) {
        devLeftovers.push(`${label}: "${placeholder}"`);
      }
    }
    return { leaked, devLeftovers };
  }, DEV_LEFTOVER_PATTERN.source).catch(() => ({ leaked: [] as string[], devLeftovers: [] as string[] }));

  if (leaked.length === 0 && devLeftovers.length === 0) {
    ctx.onLog('[Placeholder] No placeholder-value leakage or leftover dev placeholder text found');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'placeholder-check.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  if (leaked.length > 0) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Placeholder',
      title: `${leaked.length} field(s) have their placeholder text as an actual submitted value`,
      steps: ['Open this page without touching the listed field(s)', 'Inspect the field\'s value attribute/property'],
      expected: 'A placeholder is only ever a hint shown on an empty field — it should never become the field\'s real value',
      actual: `Field(s) where value === placeholder text: ${leaked.join(', ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'verified',
      confidenceReason: "Directly compares each field's live DOM value against its own placeholder attribute — an objective, unambiguous match, not inferred.",
      pageUrl: page.url(),
    });
  }

  if (devLeftovers.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Placeholder',
      title: `${devLeftovers.length} field(s) have leftover dev/placeholder text instead of a real hint`,
      steps: ['Open this page', 'Inspect the placeholder text on the listed field(s)'],
      expected: 'Placeholder text should be a real, user-facing hint (e.g. "Enter your email")',
      actual: devLeftovers.join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
    });
  }
}
