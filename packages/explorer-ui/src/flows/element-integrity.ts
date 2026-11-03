// Interactive-element integrity: occlusion, disabled-state mismatch, zero-size/off-screen,
// and mobile touch-target size. All operate on the same "scan every interactive element" pass.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

function shotPath(ctx: ExecutorContext, name: string): string {
  return join(ctx.sessionsDir, ctx.sessionId, 'screenshots', name);
}

export async function runElementIntegrity(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[UI] Scanning interactive elements for occlusion, disabled-state mismatch, zero-size/off-screen');

  const issues = await page.evaluate(() => {
    const describeEl = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute('aria-label');
      const text = (el.textContent ?? '').trim().slice(0, 30);
      const href = el.getAttribute('href');
      const detail = aria
        ? `aria-label="${aria}"`
        : text
          ? `"${text}"`
          : href
            ? `href="${href.slice(0, 40)}"`
            : '';
      return detail ? `${tag} ${detail}` : tag;
    };

    const occluded: string[] = [];
    const disabledMismatch: string[] = [];
    const zeroOrOffscreen: string[] = [];

    const interactive = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [onclick]'),
    );

    for (const el of interactive) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      // Content inside aria-hidden/inert containers (closed drawers, off-canvas menus) is
      // deliberately out of reach — not a defect of the element itself.
      if (el.closest('[aria-hidden="true"], [inert]')) continue;

      const rect = el.getBoundingClientRect();
      const isZeroSize = rect.width === 0 || rect.height === 0;
      // "Off-screen" means outside the DOCUMENT, not outside the current viewport. Measuring
      // against the viewport flagged every footer link and below-the-fold button as
      // unreachable, when the user simply scrolls to them.
      const docLeft = rect.left + window.scrollX;
      const docTop = rect.top + window.scrollY;
      const docWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
      const docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      const isOffscreen =
        docLeft + rect.width <= 0 || docTop + rect.height <= 0 || docLeft >= docWidth || docTop >= docHeight;

      if (isZeroSize || isOffscreen) {
        if (el.getAttribute('tabindex') !== '-1') {
          zeroOrOffscreen.push(`${describeEl(el)} ${isZeroSize ? '(0-size)' : '(off-screen)'}`);
        }
        continue;
      }

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
          occluded.push(`${describeEl(el)} blocked by ${describeEl(topEl)}`);
        }
      }

      const isActuallyDisabled =
        (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
      // A nearly-invisible native control laid over a styled box (the common custom-select
      // pattern — e.g. SauceDemo's sort dropdown) is transparent on purpose; the user sees the
      // styled box, not a faded control. Only moderate fading (0.2–0.6) reads as "disabled".
      const opacity = Number(style.opacity);
      const fadedLikeDisabled = opacity >= 0.2 && opacity < 0.6;
      // Class check is per class TOKEN: Tailwind-style variant classes ("disabled:opacity-50",
      // "disabled:cursor-not-allowed") only apply WHEN disabled — matching the bare word inside
      // them flagged every enabled Tailwind button as "looks disabled".
      const classTokens = (typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '').split(/\s+/);
      const disabledClass = classTokens.some(
        (c) => !c.includes(':') && /^(disabled|is-disabled|[\w-]*[-_]disabled|[\w-]*--disabled)$/i.test(c),
      );
      // Carousel / slider / pager indicators ("Go to slide 2", "Banner 3") are drawn faded when
      // they're not the current one — that's "inactive", not "disabled".
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
      const isIndicator =
        /\b(slide|banner|page|item|image|dot)\s*\d+\b/i.test(label) ||
        ['tab', 'option'].includes(el.getAttribute('role') ?? '') ||
        el.hasAttribute('aria-selected') ||
        el.hasAttribute('aria-current');
      const looksDisabled =
        !isIndicator && (fadedLikeDisabled || disabledClass || style.cursor === 'not-allowed');

      if (looksDisabled && !isActuallyDisabled) {
        disabledMismatch.push(`${describeEl(el)} looks disabled but is clickable`);
      }
      if (isActuallyDisabled && style.cursor === 'pointer') {
        disabledMismatch.push(`${describeEl(el)} is disabled but shows pointer cursor`);
      }
    }

    return {
      occluded: occluded.slice(0, 8),
      disabledMismatch: disabledMismatch.slice(0, 8),
      zeroOrOffscreen: zeroOrOffscreen.slice(0, 8),
    };
  });

  if (issues.occluded.length === 0 && issues.disabledMismatch.length === 0 && issues.zeroOrOffscreen.length === 0) {
    ctx.onLog('[UI] No occlusion, disabled-state mismatch, or zero-size/off-screen issues found');
    return;
  }

  const shot = shotPath(ctx, 'element-integrity.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  const pageUrl = page.url();

  if (issues.occluded.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-ElementIntegrity',
      title: `${issues.occluded.length} interactive element(s) blocked by an overlapping element`,
      steps: [
        `Open ${pageUrl}`,
        'For each element below, locate it (search DevTools → Elements for its text/aria-label), note its screen position',
        'Click at that exact position — you will hit the blocking element instead (see which one after "blocked by")',
      ],
      expected: 'Clicking a visible interactive element should activate that element, not something else',
      actual: issues.occluded.join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  if (issues.disabledMismatch.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-ElementIntegrity',
      title: `${issues.disabledMismatch.length} element(s) with disabled-state visual/actual mismatch`,
      steps: [
        `Open ${pageUrl}`,
        'Find each element listed below by its text/aria-label (Ctrl+F in DevTools → Elements, or visually)',
        'Compare how it looks (greyed out / not-allowed cursor) against whether it actually responds to a click',
      ],
      expected: 'Visual disabled styling should match the actual disabled state',
      actual: issues.disabledMismatch.join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  if (issues.zeroOrOffscreen.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ElementIntegrity',
      title: `${issues.zeroOrOffscreen.length} interactive element(s) with zero size or off-screen but still tabbable`,
      steps: [
        `Open ${pageUrl}`,
        'Click into the page, then press Tab repeatedly',
        'For each element listed below, notice keyboard focus lands on it but nothing is visible on screen',
      ],
      expected: 'Tabbable elements should be visible and reachable, or removed from the tab order (tabindex="-1")',
      actual: issues.zeroOrOffscreen.join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}

const MOBILE_VIEWPORT = { width: 375, height: 812 };
// WCAG 2.2 SC 2.5.8 (AA) sets 24×24px as the minimum target size; 44×44px is the stricter AAA /
// platform-guideline recommendation. Below 24 is a finding; 24–43 is only logged as advice.
const MIN_TOUCH_TARGET = 24;
const RECOMMENDED_TOUCH_TARGET = 44;

export async function runTouchTargetCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[UI] Checking touch target sizes at mobile viewport');

  const original = page.viewportSize();
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(500);

  const tooSmall = await page.evaluate((min) => {
    const interactive = Array.from(
      document.querySelectorAll(
        'button, a[href], input[type="checkbox"], input[type="radio"], input[type="submit"], [role="button"]',
      ),
    );
    const results: string[] = [];
    for (const el of interactive) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      // Closed drawers / off-canvas menus: not tappable until opened, so not measured.
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= 0 || rect.left >= window.innerWidth) continue;
      // WCAG exception: a link inside a sentence is sized by the text around it.
      if (style.display === 'inline' && el.tagName === 'A') {
        const parentText = (el.parentElement?.textContent ?? '').trim().length;
        if (parentText > (el.textContent ?? '').trim().length + 20) continue;
      }
      if (rect.width < min || rect.height < min) {
        const text =
          (el.textContent ?? '').trim().slice(0, 25) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('href')?.slice(0, 30) ||
          `${el.tagName.toLowerCase()} (no text/label/href)`;
        results.push(`"${text}" (${Math.round(rect.width)}×${Math.round(rect.height)}px)`);
      }
    }
    return results.slice(0, 10);
  }, MIN_TOUCH_TARGET);

  if (tooSmall.length === 0) {
    ctx.onLog('[UI] All interactive elements meet minimum touch target size at mobile viewport');
  } else {
    const shot = shotPath(ctx, 'touch-target.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    ctx.onFinding({
      severity: 'low',
      area: 'UI-TouchTarget',
      title: `${tooSmall.length} interactive element(s) smaller than ${MIN_TOUCH_TARGET}×${MIN_TOUCH_TARGET}px at mobile viewport`,
      steps: [
        `Open ${page.url()}`,
        `In DevTools, toggle device toolbar and set viewport to ${MOBILE_VIEWPORT.width}×${MOBILE_VIEWPORT.height} (or resize the browser window to that size), then reload`,
        `For each element listed below (with its current size in px), try tapping it with a finger-sized pointer — the listed size is below the ${MIN_TOUCH_TARGET}×${MIN_TOUCH_TARGET}px minimum tap target`,
      ],
      expected: `Touch targets should be at least ${MIN_TOUCH_TARGET}×${MIN_TOUCH_TARGET}px (WCAG 2.2 AA); ${RECOMMENDED_TOUCH_TARGET}×${RECOMMENDED_TOUCH_TARGET}px recommended`,
      actual: tooSmall.join(', '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  if (original) await page.setViewportSize(original);
}
