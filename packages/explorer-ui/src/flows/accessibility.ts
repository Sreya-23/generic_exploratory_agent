/**
 * Accessibility flows E1–E3.
 * Real audits (not navigation fallback): labels/ARIA, keyboard semantics, contrast.
 */
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask, Severity } from '@qa/shared';
import { join } from 'node:path';

const MAX_FINDINGS_PER_CHECK = 8;

function emit(
  ctx: ExecutorContext,
  partial: {
    severity: Severity;
    area: string;
    title: string;
    steps: string[];
    expected: string;
    actual: string;
  },
  evidence: string[],
): void {
  ctx.onFinding({
    ...partial,
    evidence,
    reproRate: '1/1',
    automationCandidate: true,
  });
}

async function screenshot(page: Page, ctx: ExecutorContext, name: string): Promise<string> {
  const path = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `${name}.png`);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  return path;
}

/** E1 — Labels & ARIA: inputs without names, unlabeled buttons, images without alt */
export async function runLabelsAria(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y/E1] Auditing labels and ARIA accessible names…');
  const shot = await screenshot(page, ctx, `${task.id}-labels`);

  const issues = await page.evaluate((max) => {
    type Issue = { kind: string; detail: string; severity: 'high' | 'medium' | 'low' };
    const out: Issue[] = [];

    function accessibleName(el: Element): string {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      const title = el.getAttribute('title')?.trim();
      if (title) return title;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.labels && el.labels.length > 0) {
          return Array.from(el.labels)
            .map((l) => l.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ');
        }
        const id = el.id;
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab?.textContent?.trim()) return lab.textContent.trim();
        }
        // Placeholder alone is not a sufficient accessible name (WCAG)
        return '';
      }
      if (el instanceof HTMLImageElement) {
        return el.getAttribute('alt')?.trim() ?? '';
      }
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Form controls without accessible names
    const controls = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), select, textarea',
    );
    for (const el of Array.from(controls)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      if ((el as HTMLInputElement).disabled) continue;
      const name = accessibleName(el);
      if (!name) {
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type || '';
        const id = el.id || el.getAttribute('name') || '(no id/name)';
        out.push({
          kind: 'missing-input-label',
          detail: `<${tag}${type ? ` type="${type}"` : ''}> id/name="${id}" has no label, aria-label, or aria-labelledby`,
          severity: 'high',
        });
      }
    }

    // Buttons / links / role=button without accessible names
    const clickables = document.querySelectorAll(
      'button, a[href], [role="button"], input[type="submit"], input[type="button"]',
    );
    for (const el of Array.from(clickables)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      const name = accessibleName(el);
      // Icon-only: check for nested img alt / aria
      if (!name) {
        const nestedImg = el.querySelector('img[alt]');
        const nestedAria = el.querySelector('[aria-label]');
        if (nestedImg?.getAttribute('alt')?.trim() || nestedAria?.getAttribute('aria-label')?.trim()) {
          continue;
        }
        const tag = el.tagName.toLowerCase();
        const preview = (el.outerHTML || '').slice(0, 120).replace(/\s+/g, ' ');
        out.push({
          kind: 'missing-control-name',
          detail: `<${tag}> has no accessible name (empty text, no aria-label). Preview: ${preview}`,
          severity: 'medium',
        });
      }
    }

    // Images without alt
    const images = document.querySelectorAll('img');
    for (const img of Array.from(images)) {
      if (out.length >= max) break;
      if (!isVisible(img)) continue;
      if (!img.hasAttribute('alt')) {
        const src = (img.getAttribute('src') || '').slice(0, 80);
        out.push({
          kind: 'missing-alt',
          detail: `<img> missing alt attribute (src="${src}")`,
          severity: 'medium',
        });
      }
    }

    // ARIA: elements with aria-hidden="true" that are focusable
    const hiddenFocusable = document.querySelectorAll(
      '[aria-hidden="true"] a[href], [aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] [tabindex]:not([tabindex="-1"])',
    );
    for (const el of Array.from(hiddenFocusable)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      out.push({
        kind: 'aria-hidden-focusable',
        detail: `Focusable <${el.tagName.toLowerCase()}> inside aria-hidden="true" — hidden from AT but still in tab order`,
        severity: 'high',
      });
    }

    return out;
  }, MAX_FINDINGS_PER_CHECK);

  if (issues.length === 0) {
    ctx.onLog('[A11y/E1] No label/ARIA issues found on this page');
    return;
  }

  for (const issue of issues) {
    emit(
      ctx,
      {
        severity: issue.severity,
        area: 'accessibility',
        title:
          issue.kind === 'missing-input-label'
            ? 'Form control missing accessible label'
            : issue.kind === 'missing-control-name'
              ? 'Interactive control missing accessible name'
              : issue.kind === 'missing-alt'
                ? 'Image missing alt text'
                : 'Focusable element inside aria-hidden',
        steps: [
          'Open the page under test',
          'Inspect form controls, buttons/links, and images for accessible names',
          'Check aria-hidden containers for focusable descendants',
        ],
        expected: 'Every interactive control and informative image has an accessible name (WCAG 1.1.1 / 4.1.2)',
        actual: issue.detail,
      },
      [shot],
    );
  }

  ctx.onLog(`[A11y/E1] Reported ${issues.length} label/ARIA finding(s)`);
}

/** E2 — Keyboard access: non-focusable interactive widgets (beyond A5 Tab-order check) */
export async function runKeyboardAccess(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y/E2] Auditing keyboard accessibility of interactive controls…');
  const shot = await screenshot(page, ctx, `${task.id}-keyboard`);

  const issues = await page.evaluate((max) => {
    type Issue = { kind: string; detail: string; severity: 'high' | 'medium' | 'low' };
    const out: Issue[] = [];

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isNativelyFocusable(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return true;
      if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        return type !== 'hidden';
      }
      if (tag === 'summary') return true;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) >= 0) return true;
      return false;
    }

    // Custom interactive widgets that look clickable but aren't keyboard-reachable
    const candidates = document.querySelectorAll(
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [onclick], [data-action], .btn, [class*="button"]',
    );

    for (const el of Array.from(candidates)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      // Native interactive elements are fine
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {
        continue;
      }
      if (isNativelyFocusable(el)) continue;

      const role = el.getAttribute('role') || '';
      const cls = (el.getAttribute('class') || '').slice(0, 60);
      out.push({
        kind: 'not-keyboard-focusable',
        detail: `<${tag}${role ? ` role="${role}"` : ''}${cls ? ` class="${cls}"` : ''}> appears interactive but is not focusable (no tabindex≥0) — keyboard/AT users cannot reach it`,
        severity: 'high',
      });
    }

    // Positive tabindex > 0 (anti-pattern — disrupts natural tab order)
    const positiveTab = document.querySelectorAll('[tabindex]');
    for (const el of Array.from(positiveTab)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      const ti = Number(el.getAttribute('tabindex'));
      if (ti > 0) {
        out.push({
          kind: 'positive-tabindex',
          detail: `<${el.tagName.toLowerCase()}> uses tabindex="${ti}" — positive tabindex disrupts natural keyboard order (WCAG 2.4.3)`,
          severity: 'low',
        });
      }
    }

    // Disabled-looking links without href (not keyboard operable)
    const fakeLinks = document.querySelectorAll('a:not([href]), a[href=""], a[href="#"]');
    let fakeLinkCount = 0;
    for (const el of Array.from(fakeLinks)) {
      if (!isVisible(el)) continue;
      if ((el as HTMLElement).onclick || el.getAttribute('role') === 'button') {
        fakeLinkCount++;
      }
    }
    if (fakeLinkCount > 0 && out.length < max) {
      out.push({
        kind: 'fake-links',
        detail: `${fakeLinkCount} <a> element(s) without a real href act as buttons — prefer <button> or add keyboard handlers + role`,
        severity: 'medium',
      });
    }

    return out;
  }, MAX_FINDINGS_PER_CHECK);

  // Practical check: Tab through and ensure we can activate a button with Enter
  await page.click('body', { position: { x: 0, y: 0 } }).catch(() => {});
  await page.waitForTimeout(100);

  let reachedButton = false;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', role: '', type: '' };
      return {
        tag: el.tagName,
        role: el.getAttribute('role') ?? '',
        type: (el as HTMLInputElement).type ?? '',
      };
    });
    if (
      info.tag === 'BUTTON' ||
      info.role === 'button' ||
      (info.tag === 'INPUT' && ['submit', 'button'].includes(info.type)) ||
      info.tag === 'A'
    ) {
      reachedButton = true;
      break;
    }
  }

  if (!reachedButton) {
    const focusableCount = await page
      .locator('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
      .count();
    if (focusableCount > 0) {
      emit(
        ctx,
        {
          severity: 'medium',
          area: 'accessibility',
          title: 'Keyboard user cannot reach primary interactive controls via Tab',
          steps: [
            'Click page body to set focus',
            'Press Tab up to 12 times',
            'Check whether focus lands on a button, link, or submit control',
          ],
          expected: 'At least one primary interactive control is reachable via Tab (WCAG 2.1.1)',
          actual: `Tabbed 12 times without focusing a button/link; page has ${focusableCount} focusable element(s)`,
        },
        [shot],
      );
    }
  }

  for (const issue of issues) {
    emit(
      ctx,
      {
        severity: issue.severity,
        area: 'accessibility',
        title:
          issue.kind === 'not-keyboard-focusable'
            ? 'Interactive widget not keyboard-focusable'
            : issue.kind === 'positive-tabindex'
              ? 'Positive tabindex disrupts tab order'
              : 'Anchor used as button without real href',
        steps: [
          'Inspect interactive widgets (role=button, onclick, custom .btn)',
          'Verify each is focusable (native control or tabindex≥0)',
          'Verify activation works with Enter/Space',
        ],
        expected: 'All interactive UI is reachable and operable via keyboard (WCAG 2.1.1)',
        actual: issue.detail,
      },
      [shot],
    );
  }

  ctx.onLog(
    `[A11y/E2] Keyboard audit done — DOM issues: ${issues.length}, reached control via Tab: ${reachedButton}`,
  );
}

/** E3 — Colour contrast: sample visible text against computed background (WCAG AA) */
export async function runContrast(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  ctx.onLog('[A11y/E3] Sampling text colour contrast ratios…');
  const shot = await screenshot(page, ctx, `${task.id}-contrast`);

  const issues = await page.evaluate((max) => {
    type Issue = { detail: string; ratio: number; required: number; severity: 'medium' | 'low' };
    const out: Issue[] = [];

    function parseColor(css: string): { r: number; g: number; b: number; a: number } | null {
      const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return null;
      return {
        r: Number(m[1]),
        g: Number(m[2]),
        b: Number(m[3]),
        a: m[4] !== undefined ? Number(m[4]) : 1,
      };
    }

    function srgbToLin(c: number): number {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function luminance(r: number, g: number, b: number): number {
      return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
    }

    function contrastRatio(
      fg: { r: number; g: number; b: number },
      bg: { r: number; g: number; b: number },
    ): number {
      const L1 = luminance(fg.r, fg.g, fg.b);
      const L2 = luminance(bg.r, bg.g, bg.b);
      const lighter = Math.max(L1, L2);
      const darker = Math.min(L1, L2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function effectiveBackground(el: Element): { r: number; g: number; b: number } | null {
      let node: Element | null = el;
      while (node && node !== document.documentElement) {
        const bg = parseColor(window.getComputedStyle(node).backgroundColor);
        if (bg && bg.a >= 0.85) {
          // Blend over white if semi-transparent
          if (bg.a < 1) {
            return {
              r: Math.round(bg.r * bg.a + 255 * (1 - bg.a)),
              g: Math.round(bg.g * bg.a + 255 * (1 - bg.a)),
              b: Math.round(bg.b * bg.a + 255 * (1 - bg.a)),
            };
          }
          return { r: bg.r, g: bg.g, b: bg.b };
        }
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255 };
    }

    const selectors = 'p, span, a, label, button, h1, h2, h3, h4, h5, h6, li, td, th, div';
    const nodes = Array.from(document.querySelectorAll(selectors));
    const seen = new Set<string>();

    for (const el of nodes) {
      if (out.length >= max) break;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // Only leaf-ish text: own direct text content
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (ownText.length < 2) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      // Skip off-screen
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      const fg = parseColor(style.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = effectiveBackground(el);
      if (!bg) continue;

      const ratio = contrastRatio(fg, bg);
      const fontSizePx = parseFloat(style.fontSize) || 16;
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isLarge =
        fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
      const required = isLarge ? 3 : 4.5;

      if (ratio + 0.05 >= required) continue;

      const key = `${Math.round(ratio * 10)}|${style.color}|${ownText.slice(0, 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        detail: `Text "${ownText.slice(0, 40)}${ownText.length > 40 ? '…' : ''}" contrast ${ratio.toFixed(2)}:1 (need ≥${required}:1 for ${isLarge ? 'large' : 'normal'} text). color=${style.color}`,
        ratio,
        required,
        severity: ratio < 2.5 ? 'medium' : 'low',
      });
    }

    return out;
  }, MAX_FINDINGS_PER_CHECK);

  if (issues.length === 0) {
    ctx.onLog('[A11y/E3] No contrast failures in sampled text');
    return;
  }

  for (const issue of issues) {
    emit(
      ctx,
      {
        severity: issue.severity,
        area: 'accessibility',
        title: `Insufficient colour contrast (${issue.ratio.toFixed(2)}:1)`,
        steps: [
          'Sample visible text on the page',
          'Compute WCAG relative-luminance contrast vs effective background',
          `Compare against AA threshold (≥${issue.required}:1)`,
        ],
        expected: `Text contrast ≥ ${issue.required}:1 (WCAG 1.4.3 AA)`,
        actual: issue.detail,
      },
      [shot],
    );
  }

  ctx.onLog(`[A11y/E3] Reported ${issues.length} contrast finding(s)`);
}
