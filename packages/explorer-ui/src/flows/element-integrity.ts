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

      const rect = el.getBoundingClientRect();
      const isZeroSize = rect.width === 0 || rect.height === 0;
      const isOffscreen =
        rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth;

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
      const looksDisabled =
        Number(style.opacity) < 0.6 || /\bdisabled\b/i.test(el.className) || style.cursor === 'not-allowed';

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
const MIN_TOUCH_TARGET = 44;

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
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
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
        'For each element listed below (with its current size in px), try tapping it with a finger-sized pointer — the listed size is below the 44×44px minimum tap target',
      ],
      expected: `Touch targets should be at least ${MIN_TOUCH_TARGET}×${MIN_TOUCH_TARGET}px per mobile UX guidelines`,
      actual: tooSmall.join(', '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  if (original) await page.setViewportSize(original);
}
