import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Leftover dev/placeholder text left in an actual placeholder attribute — the same class of
// "obviously fake" content visual-review.ts's Gemini prompt looks for on-screen, applied to
// the one place a plain DOM scan can check for it directly and cheaply.
const DEV_LEFTOVER_PATTERN = /lorem ipsum|^(todo|fixme|test|placeholder|xxx+|foo|bar|asdf)$/i;

// An unresolved template-interpolation variable rendered as literal visible text (e.g. a
// heading showing "${FinancialSummaryTitle}" instead of its real title) — confirmed real,
// live on a production page. Before this, the ONLY thing that could ever catch this class of
// bug was the optional, Gemini-gated visual-review flow, which only screenshots 1-2 pages per
// session — everywhere else, on every other page, this kind of leak was invisible to the
// agent entirely. This is a cheap, deterministic, always-runs check for the same thing.
const TEMPLATE_LEAK_PATTERN = /\$\{\s*[a-zA-Z_][\w.]*\s*\}|\{\{\s*[a-zA-Z_][\w.]*\s*\}\}|%\{\s*[a-zA-Z_][\w.]*\s*\}%/;

export async function runPlaceholderCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Placeholder] Checking placeholder text quality and value/placeholder leakage');

  const { leaked, devLeftovers, templateLeaks } = await page.evaluate(
    ({ devPattern, templatePattern }) => {
      const devRe = new RegExp(devPattern, 'i');
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

        if (devRe.test(placeholder)) {
          devLeftovers.push(`${label}: "${placeholder}"`);
        }
      }

      // Walk every visible text node on the page looking for an unresolved template
      // variable — not scoped to form fields, since this class of bug shows up in headings,
      // banners, labels, anywhere a template string can be interpolated.
      const templateRe = new RegExp(templatePattern);
      const templateLeaks: string[] = [];
      const seen = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim();
        if (!text) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const match = text.match(templateRe);
        if (match && !seen.has(match[0])) {
          seen.add(match[0]);
          templateLeaks.push(text.length > 80 ? `${match[0]} (in: "${text.slice(0, 80)}…")` : text);
        }
      }

      return { leaked, devLeftovers, templateLeaks };
    },
    { devPattern: DEV_LEFTOVER_PATTERN.source, templatePattern: TEMPLATE_LEAK_PATTERN.source },
  ).catch(() => ({ leaked: [] as string[], devLeftovers: [] as string[], templateLeaks: [] as string[] }));

  if (leaked.length === 0 && devLeftovers.length === 0 && templateLeaks.length === 0) {
    ctx.onLog('[Placeholder] No placeholder-value leakage, leftover dev text, or unresolved template variables found');
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

  if (templateLeaks.length > 0) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-Placeholder',
      title: `${templateLeaks.length} unresolved template variable(s) rendered as literal visible text`,
      steps: ['Open this page', 'Look for literal template syntax instead of the real interpolated text (e.g. in banners, headings, or promo content)'],
      expected: 'Template variables are interpolated with real values before being shown to the user',
      actual: `Literal unresolved template text found: ${templateLeaks.join('; ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'verified',
      confidenceReason: 'Matched directly against live visible text nodes on the page — the literal characters are unambiguously present, not inferred.',
      pageUrl: page.url(),
    });
  }
}
