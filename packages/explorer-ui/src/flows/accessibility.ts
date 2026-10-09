// E1/E2/E3 — Labels & alt text, keyboard focus visibility, colour contrast
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

function shotPath(ctx: ExecutorContext, name: string): string {
  return join(ctx.sessionsDir, ctx.sessionId, 'screenshots', name);
}

// E1 — Labels & ARIA
export async function runLabelsCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y] Checking form field labels and image alt text');

  const unlabeledInputs = await page.evaluate(() => {
    const results: { tag: string; type: string; name: string }[] = [];
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
    for (const el of inputs) {
      const input = el as HTMLInputElement;
      if (['hidden', 'submit', 'button'].includes(input.type)) continue;
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const hasAriaLabel = !!input.getAttribute('aria-label')?.trim();
      const hasAriaLabelledby = input.hasAttribute('aria-labelledby');
      const hasTitle = !!input.getAttribute('title')?.trim();
      const hasLabelFor = input.id ? !!document.querySelector(`label[for="${input.id}"]`) : false;
      const hasWrappingLabel = !!input.closest('label');

      if (!hasAriaLabel && !hasAriaLabelledby && !hasTitle && !hasLabelFor && !hasWrappingLabel) {
        results.push({
          tag: input.tagName.toLowerCase(),
          type: input.type || 'text',
          name: input.name || input.id || '(unnamed)',
        });
      }
    }
    return results.slice(0, 10);
  });

  const unlabeledImages = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs
      .filter((img) => {
        const style = window.getComputedStyle(img);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return img.getAttribute('alt') === null; // missing entirely; alt="" is valid (decorative)
      })
      .map((img) => (img as HTMLImageElement).src.slice(0, 80))
      .slice(0, 10);
  });

  if (unlabeledInputs.length === 0 && unlabeledImages.length === 0) {
    ctx.onLog('[A11y] All form fields and images have accessible labels/alt text');
    return;
  }

  const shot = shotPath(ctx, 'a11y-labels.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  if (unlabeledInputs.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'A11y-Labels',
      title: `${unlabeledInputs.length} form field(s) with no accessible label`,
      steps: [
        `Open ${page.url()}`,
        'Turn on a screen reader (e.g. VoiceOver/NVDA) or open DevTools → Accessibility pane',
        `Tab to each field listed below (identified by tag[type] and its name/id attribute) — it announces no name, only its type`,
      ],
      expected: 'Every form control has an accessible label',
      actual: `Unlabeled: ${unlabeledInputs.map((i) => `${i.tag}[${i.type}] "${i.name}"`).join(', ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  if (unlabeledImages.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'A11y-Labels',
      title: `${unlabeledImages.length} image(s) missing alt attribute`,
      steps: [
        `Open ${page.url()}`,
        'Open DevTools → Elements, search for each <img> src listed below',
        'Confirm it has no alt attribute at all (not even alt="")',
      ],
      expected: 'Every meaningful image has an alt attribute (alt="" is fine for decorative images)',
      actual: `Missing alt: ${unlabeledImages.join(', ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}

// E2 — Keyboard focus visibility
export async function runKeyboardCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y] Tabbing through the page to check focus indicator visibility');

  const noFocusIndicator: string[] = [];
  const TAB_STEPS = 15;

  await page.keyboard.press('Tab').catch(() => {});
  for (let i = 0; i < TAB_STEPS; i++) {
    const info = await page
      .evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = window.getComputedStyle(el);
        const hasOutline = style.outlineStyle !== 'none' && style.outlineWidth !== '0px';
        const hasBoxShadow = style.boxShadow !== 'none';
        const tag = el.tagName.toLowerCase();
        const aria = el.getAttribute('aria-label');
        // innerText (not textContent) — textContent concatenates every nested text node
        // with NO separator at all, so a wrapper div with two sibling labels inside (e.g.
        // "Branch" + "Holy Mary Publ...") jams them into one unreadable run like
        // "BranchHoly Mary Publ". innerText approximates rendered text, inserting
        // whitespace/newlines between block-level children the way a user would see them.
        const text = el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 30);
        const href = el.getAttribute('href');
        const detail = aria
          ? `aria-label="${aria}"`
          : text
            ? `"${text}"`
            : href
              ? `href="${href.slice(0, 30)}"`
              : '';
        const label = detail ? `${tag} ${detail}` : tag;
        return { visible: hasOutline || hasBoxShadow, label };
      })
      .catch(() => null);

    if (!info) break;
    if (!info.visible) noFocusIndicator.push(info.label);
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(80);
  }

  const uniqueMissing = [...new Set(noFocusIndicator)].slice(0, 8);
  if (uniqueMissing.length === 0) {
    ctx.onLog('[A11y] Focus indicators look OK across tabbed elements');
    return;
  }

  const shot = shotPath(ctx, 'a11y-keyboard.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'A11y-Keyboard',
    title: `${uniqueMissing.length} focusable element(s) with no visible focus indicator`,
    steps: [
      `Open ${page.url()}`,
      'Click into the page, then press Tab repeatedly',
      'For each element listed below, notice no outline or highlight appears around it when it receives keyboard focus',
    ],
    expected: 'Every focusable element shows a visible focus indicator (outline or box-shadow) for keyboard users',
    actual: `No visible focus style on: ${uniqueMissing.join(', ')}`,
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
  });
}

// E4 — Semantic structure: heading hierarchy, button/link semantics, accessible names on
// interactive controls beyond form fields/images (E1 only scans input/select/textarea/img).
// Deliberately does NOT attempt "information conveyed only through color" — reliably
// distinguishing a legitimate color-only accent from a genuine accessibility violation without
// a prohibitive false-positive rate isn't achievable with a generic DOM heuristic.
export async function runSemanticStructureCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y] Checking heading hierarchy, button/link semantics, and interactive accessible names');

  const headingIssues = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .filter((h) => {
        const style = window.getComputedStyle(h);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((h) => Number(h.tagName[1]));
    const issues: string[] = [];
    const h1Count = headings.filter((l) => l === 1).length;
    if (h1Count > 1) issues.push(`${h1Count} <h1> elements on the page (should normally be exactly one)`);
    if (h1Count === 0 && headings.length > 0) issues.push('No <h1> found, but lower-level headings exist');
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] - headings[i - 1] > 1) {
        issues.push(`Heading level skips from h${headings[i - 1]} to h${headings[i]}`);
        break; // one example is enough signal — avoid flooding with every skip on the page
      }
    }
    return issues;
  });

  for (const issue of headingIssues) {
    ctx.onFinding({
      severity: 'low',
      area: 'A11y-Structure',
      title: `Heading hierarchy issue: ${issue}`,
      steps: [`Open ${page.url()}`, 'Inspect the document\'s heading elements (h1-h6) in DOM order'],
      expected: 'Exactly one <h1>, with no skipped levels (h2 should not jump straight to h4, etc.)',
      actual: issue,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Heading structure conventions have legitimate exceptions (e.g. a widget embedding its own heading scope) — verify before treating as confirmed.',
    });
  }

  const semanticIssues = await page.evaluate(() => {
    const results: { kind: 'no-name' | 'div-as-button'; detail: string }[] = [];
    // Interactive controls with no accessible name at all (beyond E1's input/img scope).
    const controls = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
    for (const el of controls.slice(0, 500)) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (el as HTMLElement).innerText?.trim();
      const ariaLabel = el.getAttribute('aria-label')?.trim();
      const ariaLabelledby = el.getAttribute('aria-labelledby');
      const title = el.getAttribute('title')?.trim();
      const hasImgAlt = el.querySelector('img[alt]:not([alt=""])') !== null;
      if (!text && !ariaLabel && !ariaLabelledby && !title && !hasImgAlt) {
        const tag = el.tagName.toLowerCase();
        const cls = (el.getAttribute('class') ?? '').slice(0, 40);
        results.push({ kind: 'no-name', detail: `${tag}${cls ? `.${cls.split(' ')[0]}` : ''}` });
      }
    }
    // Non-native clickables (div/span with onclick) with no button role and no keyboard handler
    // signal (no tabindex) — a real semantic-misuse pattern distinct from the "no accessible
    // name" case above.
    const divButtons = Array.from(document.querySelectorAll('div[onclick], span[onclick]'));
    for (const el of divButtons.slice(0, 200)) {
      const role = el.getAttribute('role');
      const tabindex = el.getAttribute('tabindex');
      if (role !== 'button' && tabindex === null) {
        results.push({ kind: 'div-as-button', detail: `${el.tagName.toLowerCase()}[onclick] with no role="button" and no tabindex` });
      }
    }
    return results;
  });

  const noName = [...new Set(semanticIssues.filter((s) => s.kind === 'no-name').map((s) => s.detail))].slice(0, 8);
  if (noName.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'A11y-Structure',
      title: `${noName.length} interactive control(s) with no accessible name`,
      steps: [`Open ${page.url()}`, 'Tab to each control listed below — a screen reader announces nothing identifying it'],
      expected: 'Every button/link has visible text, an aria-label, aria-labelledby, title, or a meaningfully-alt\'d image',
      actual: `No accessible name: ${noName.join(', ')}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  const divAsButton = [...new Set(semanticIssues.filter((s) => s.kind === 'div-as-button').map((s) => s.detail))].slice(0, 5);
  if (divAsButton.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'A11y-Structure',
      title: `${divAsButton.length} clickable <div>/<span> element(s) with incorrect semantics`,
      steps: [`Open ${page.url()}`, 'Inspect elements with an onclick handler but no role="button" or tabindex'],
      expected: 'A clickable element should be a <button>, or carry role="button" and tabindex="0" for keyboard operability',
      actual: `Incorrect semantics: ${divAsButton.join(', ')}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'verified',
      confidenceReason: 'Directly observed: the element has an onclick handler but neither the ARIA role nor the keyboard-focusability a real button needs.',
    });
  }

  if (headingIssues.length === 0 && noName.length === 0 && divAsButton.length === 0) {
    ctx.onLog('[A11y] Heading hierarchy, button/link semantics, and accessible names look OK');
  }
}

// E3 — Colour contrast (WCAG AA)
export async function runContrastCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y] Checking text/background colour contrast (WCAG AA)');

  const lowContrast = await page.evaluate(() => {
    function parseColor(c: string): [number, number, number, number] {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) return [0, 0, 0, 0];
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
    }
    function luminance([r, g, b]: [number, number, number, number]): number {
      const [rs, gs, bs] = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }
    function contrastRatio(
      fg: [number, number, number, number],
      bg: [number, number, number, number],
    ): number {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }
    function effectiveBackground(el: Element): [number, number, number, number] {
      let node: Element | null = el;
      while (node) {
        const bg = parseColor(window.getComputedStyle(node).backgroundColor);
        if (bg[3] > 0) return bg;
        node = node.parentElement;
      }
      return [255, 255, 255, 1];
    }

    const results: { text: string; ratio: number; required: number }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    let scanned = 0;
    while (node && scanned < 2000) {
      scanned++;
      const el = node as HTMLElement;
      node = walker.nextNode();

      const hasDirectText = Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
      );
      const text = el.textContent?.trim() ?? '';
      if (!hasDirectText || text.length === 0) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const fg = parseColor(style.color);
      const bg = effectiveBackground(el);
      const ratio = contrastRatio(fg, bg);

      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const required = isLarge ? 3 : 4.5;

      if (ratio < required) {
        results.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, required });
      }
    }
    return results;
  });

  const unique = [...new Map(lowContrast.map((r) => [r.text, r])).values()].slice(0, 10);
  if (unique.length === 0) {
    ctx.onLog('[A11y] No low-contrast text detected');
    return;
  }

  const shot = shotPath(ctx, 'a11y-contrast.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'medium',
    area: 'A11y-Contrast',
    title: `${unique.length} element(s) with insufficient colour contrast (WCAG AA)`,
    steps: [
      `Open ${page.url()}`,
      'Find each text listed below on the page (Ctrl+F in DevTools → Elements)',
      'Use DevTools → Elements → Styles → the contrast-ratio swatch next to `color`, or an eyedropper tool, to confirm it reads below the required ratio',
    ],
    expected: 'Text contrast ratio ≥ 4.5:1 (or ≥ 3:1 for large/bold text) per WCAG AA',
    actual: unique.map((r) => `"${r.text}" ratio=${r.ratio} (needs ${r.required})`).join('; '),
    evidence: [shot],
    reproRate: '1/1',
    automationCandidate: true,
  });
}
