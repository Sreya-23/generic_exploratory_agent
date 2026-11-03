import type { Page } from 'playwright';

// Second, independent signal for AI visual-review claims. The AI reads one screenshot and can be
// confidently wrong (observed on SauceDemo standard_user: "text overlaps the image", "image is
// stretched", "text is clipped", "login text has low contrast" — none of it true, and the last
// one contradicted by the agent's own WCAG contrast measurement). For the claim types the DOM can
// actually measure, this checks the claim against the page itself:
//   confirmed     → the measurement agrees; the finding becomes 'verified'
//   contradicted  → the measurement disagrees; the finding is dropped
//   unverifiable  → no measurable claim / element not found; kept, but capped at low severity

export type VisualCategory =
  | 'overlap'
  | 'clipped'
  | 'contrast'
  | 'image'
  | 'misaligned'
  | 'inconsistent'
  | 'broken-state'
  | 'unstyled'
  | 'placeholder'
  | 'other';

export interface CrossCheckResult {
  verdict: 'confirmed' | 'contradicted' | 'unverifiable';
  detail: string;
}

const MEASURABLE = new Set<VisualCategory>(['overlap', 'clipped', 'contrast', 'image', 'placeholder']);

// A leftover placeholder is a WHOLE value that is a dev token ("TODO", "Lorem ipsum…",
// "undefined", "{{name}}"), never a real value that happens to contain such a word.
// Observed false positive: SauceDemo's real product "Test.allTheThings() T-Shirt (Red)" was
// reported as containing placeholder text "Test.".
const PLACEHOLDER_LITERAL =
  /^(test|testing|placeholder|lorem ipsum.*|undefined|null|nan|todo|fixme|tbd|x{3,}|sample text|\[object object\])$/i;
const TEMPLATE_SYNTAX = /\{\{[^}]*\}\}|\$\{[^}]*\}/;

export function isPlaceholderValue(text: string): boolean {
  const t = text.trim().replace(/[.:!,;]+$/, '');
  return PLACEHOLDER_LITERAL.test(t) || TEMPLATE_SYNTAX.test(t);
}

export function normalizeCategory(raw: unknown, issueText: string): VisualCategory {
  const r = `${typeof raw === 'string' ? raw : ''} ${issueText}`.toLowerCase();
  if (/contrast|hard to read|readab|legib/.test(r)) return 'contrast';
  if (/overlap|collid|on top of|covers|behind/.test(r)) return 'overlap';
  if (/clip|cut off|truncat/.test(r)) return 'clipped';
  if (/image|photo|picture|thumbnail|stretch|distort|pixelat/.test(r)) return 'image';
  if (/misalign|align|spacing|uneven/.test(r)) return 'misaligned';
  if (/inconsistent|mismatch/.test(r)) return 'inconsistent';
  if (/placeholder|lorem|todo|undefined|null/.test(r)) return 'placeholder';
  if (/unstyled|stylesheet/.test(r)) return 'unstyled';
  if (/disabled|spinner|loading/.test(r)) return 'broken-state';
  return 'other';
}

/** Pull a quoted UI string ('Sauce Labs Onesie', "Login") out of the AI's description. */
export function quotedText(issue: string, provided?: unknown): string | null {
  if (typeof provided === 'string' && provided.trim().length >= 2) return provided.trim();
  const m = issue.match(/['"“‘]([^'"”’]{2,80})['"”’]/);
  return m ? m[1].trim() : null;
}

export async function crossCheckVisualClaim(
  page: Page,
  category: VisualCategory,
  elementText: string | null,
): Promise<CrossCheckResult> {
  if (!MEASURABLE.has(category)) {
    return { verdict: 'unverifiable', detail: `"${category}" claims have no reliable DOM measurement` };
  }
  if (!elementText) {
    return { verdict: 'unverifiable', detail: 'the AI did not name a specific on-page element to measure' };
  }

  if (category === 'placeholder') {
    if (!isPlaceholderValue(elementText)) {
      return {
        verdict: 'contradicted',
        detail: `"${elementText}" is real content that merely contains a placeholder-like word, not a leftover placeholder`,
      };
    }
    const target = elementText.trim();
    const found = await page
      .evaluate((t) => {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const want = norm(t);
        return Array.from(document.querySelectorAll('body *')).some(
          (el) => el.children.length === 0 && norm(el.textContent ?? '') === want,
        );
      }, target)
      .catch(() => false);
    return found
      ? { verdict: 'confirmed', detail: `an element's entire visible text is the placeholder value "${target}"` }
      : { verdict: 'contradicted', detail: `no element on the page has "${target}" as its whole text` };
  }

  return page
    .evaluate(
      ({ category, text }) => {
        const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = norm(text);
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        // Smallest visible element whose own text contains the target string.
        let el: Element | null = null;
        for (const cand of Array.from(document.querySelectorAll('body *'))) {
          if (!visible(cand)) continue;
          if (!norm(cand.textContent).includes(target)) continue;
          if (!el || (el.contains(cand) && cand !== el)) el = cand;
        }
        if (!el) return { verdict: 'unverifiable', detail: `no visible element with text "${text}" found` } as const;

        const parse = (c: string) => {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
          return { r: +r, g: +g, b: +b, a: +a };
        };
        const lum = (c: { r: number; g: number; b: number }) => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };

        if (category === 'contrast') {
          const st = getComputedStyle(el);
          const fg = parse(st.color);
          let bg: { r: number; g: number; b: number; a: number } | null = null;
          for (let n: Element | null = el; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0.5) { bg = c; break; }
            if (getComputedStyle(n).backgroundImage !== 'none') {
              return { verdict: 'unverifiable', detail: 'text sits on a background image — contrast cannot be computed' } as const;
            }
          }
          bg = bg ?? { r: 255, g: 255, b: 255, a: 1 };
          if (!fg) return { verdict: 'unverifiable', detail: 'text colour could not be read' } as const;
          const L1 = lum(fg), L2 = lum(bg);
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const size = parseFloat(st.fontSize);
          const large = size >= 24 || (size >= 18.66 && +st.fontWeight >= 700);
          const need = large ? 3 : 4.5;
          return ratio < need
            ? ({ verdict: 'confirmed', detail: `measured contrast ${ratio.toFixed(2)}:1, below the ${need}:1 WCAG AA minimum` } as const)
            : ({ verdict: 'contradicted', detail: `measured contrast ${ratio.toFixed(2)}:1 meets the ${need}:1 WCAG AA minimum` } as const);
        }

        if (category === 'clipped') {
          for (let n: Element | null = el, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
            const h = n as HTMLElement;
            const st = getComputedStyle(h);
            const hides = /hidden|clip/.test(st.overflow + st.overflowX + st.overflowY) || st.textOverflow === 'ellipsis';
            if (hides && (h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1)) {
              return { verdict: 'confirmed', detail: `content overflows a clipping container (${h.scrollWidth}×${h.scrollHeight} inside ${h.clientWidth}×${h.clientHeight})` } as const;
            }
          }
          return { verdict: 'contradicted', detail: 'no clipping container is cutting this text off' } as const;
        }

        if (category === 'overlap') {
          const a = el.getBoundingClientRect();
          const others = Array.from(document.querySelectorAll('img, svg, button, a, input, p, span, h1, h2, h3, h4, h5, h6, label, div'))
            .filter((o) => o !== el && !o.contains(el!) && !el!.contains(o) && visible(o) && (o.children.length === 0 || o.tagName === 'IMG'));
          for (const o of others) {
            const b = o.getBoundingClientRect();
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w <= 0 || h <= 0) continue;
            const overlapArea = w * h;
            const smaller = Math.min(a.width * a.height, b.width * b.height);
            if (smaller > 0 && overlapArea / smaller > 0.2) {
              return { verdict: 'confirmed', detail: `element boxes overlap by ${Math.round((overlapArea / smaller) * 100)}% with <${o.tagName.toLowerCase()}>` } as const;
            }
          }
          return { verdict: 'contradicted', detail: 'element boxes do not overlap any neighbouring content' } as const;
        }

        // image: find the image belonging to the named item (same card) and compare aspect ratios
        let card: Element | null = el;
        let img: HTMLImageElement | null = null;
        for (let depth = 0; card && depth < 5 && !img; depth++, card = card.parentElement) {
          img = card.querySelector('img');
        }
        if (!img) return { verdict: 'unverifiable', detail: 'no image found next to the named item' } as const;
        if (img.complete && img.naturalWidth === 0) {
          return { verdict: 'confirmed', detail: 'the image failed to load (naturalWidth 0)' } as const;
        }
        const r = img.getBoundingClientRect();
        const fit = getComputedStyle(img).objectFit;
        if (fit === 'cover' || fit === 'contain' || fit === 'scale-down' || !img.naturalWidth || !r.height) {
          return { verdict: 'contradicted', detail: `image keeps its proportions (object-fit: ${fit || 'n/a'})` } as const;
        }
        const natural = img.naturalWidth / img.naturalHeight;
        const shown = r.width / r.height;
        const distortion = Math.abs(shown - natural) / natural;
        return distortion > 0.15
          ? ({ verdict: 'confirmed', detail: `displayed at ${shown.toFixed(2)} aspect ratio vs ${natural.toFixed(2)} natural (${Math.round(distortion * 100)}% distortion)` } as const)
          : ({ verdict: 'contradicted', detail: `displayed proportions match the image (${Math.round(distortion * 100)}% difference)` } as const);
      },
      { category, text: elementText },
    )
    .catch((e) => ({ verdict: 'unverifiable' as const, detail: `measurement failed: ${(e as Error).message.slice(0, 80)}` }));
}
