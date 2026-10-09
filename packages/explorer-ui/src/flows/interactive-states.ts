import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

/**
 * Checklist (UI) §18 — Interactive Visual States: hover and active state. Previously zero
 * deterministic code checked whether ANYTHING visually changes when a user hovers or
 * mousedown-presses an interactive element — the only adjacent check (device-matrix.ts's
 * "hover-only-reachable" detection) is about content ONLY revealed via hover being inaccessible
 * on touch, not about whether hover/active styling itself exists at all.
 *
 * Scope: checks a handful of visible buttons/links for ANY observable style change (background,
 * color, box-shadow, outline, transform, cursor, text-decoration) between the resting state and
 * :hover / :active — a control with zero difference across all of these has no hover/active
 * feedback at all, a real (if minor) UX gap. Doesn't attempt to judge whether a SPECIFIC change
 * is "correct," only whether one exists.
 */
async function captureStyle(page: Page, selector: ReturnType<Page['locator']>) {
  return selector.evaluate((el) => {
    const s = window.getComputedStyle(el);
    return {
      bg: s.backgroundColor,
      color: s.color,
      boxShadow: s.boxShadow,
      outline: `${s.outlineStyle} ${s.outlineWidth}`,
      transform: s.transform,
      cursor: s.cursor,
      textDecoration: s.textDecorationLine,
    };
  }).catch(() => null);
}

function stylesDiffer(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (!a || !b) return false;
  return Object.keys(a).some((k) => a[k] !== b[k]);
}

export async function runInteractiveStatesCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (await isLoginWallPage(page)) {
    ctx.onLog('[InteractiveStates] Login wall detected — skipping');
    return;
  }

  const totalCandidates = await page.locator('button:visible, a[href]:visible').count().catch(() => 0);
  if (totalCandidates === 0) {
    ctx.onLog('[InteractiveStates] No visible buttons/links found');
    return;
  }

  // ── Hover state ───────────────────────────────────────────────────────────────────────────
  const hoverTargets = page.locator('button:visible, a[href]:visible');
  const sampleSize = Math.min(totalCandidates, 5);
  const noHoverFeedback: string[] = [];
  for (let i = 0; i < sampleSize; i++) {
    const el = hoverTargets.nth(i);
    const before = await captureStyle(page, el);
    await el.hover({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(100);
    const during = await captureStyle(page, el);
    await page.mouse.move(0, 0); // move away so the next element's "resting" read isn't polluted
    await page.waitForTimeout(50);

    if (before && during && !stylesDiffer(before, during)) {
      const label = await el.evaluate((node) => (node as HTMLElement).innerText?.trim().slice(0, 30) || node.tagName).catch(() => 'element');
      noHoverFeedback.push(label);
    }
  }
  const uniqueNoHover = [...new Set(noHoverFeedback)];
  if (uniqueNoHover.length === sampleSize && sampleSize > 0) {
    // Only flag when EVERY sampled element shows zero hover feedback — a site-wide pattern,
    // not a one-off (many sites legitimately skip hover styling on a specific minor control).
    ctx.onFinding({
      severity: 'low',
      area: 'UI-InteractiveStates',
      title: 'No visible hover feedback on any sampled interactive element',
      steps: [`Hover over ${sampleSize} different buttons/links`, 'Compare computed style before and during hover'],
      expected: 'Interactive elements typically show SOME visual change on hover (background, color, shadow, cursor)',
      actual: `All ${sampleSize} sampled elements showed no style difference between resting and hover state`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Some design systems intentionally use flat, no-hover-feedback controls (common on touch-first sites) — verify this is unintentional before treating as confirmed.',
    });
  } else if (uniqueNoHover.length > 0) {
    ctx.onLog(`[InteractiveStates] ${uniqueNoHover.length}/${sampleSize} sampled element(s) showed no hover style change — not flagged since most elements DO respond to hover`);
  } else {
    ctx.onLog(`[InteractiveStates] Hover feedback present on all ${sampleSize} sampled element(s)`);
  }

  // ── Active state (mousedown, before release) ─────────────────────────────────────────────
  const firstButton = page.locator('button:visible').first();
  if ((await firstButton.count()) > 0) {
    const box = await firstButton.boundingBox().catch(() => null);
    if (box) {
      const restState = await captureStyle(page, firstButton);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(100);
      const activeState = await captureStyle(page, firstButton);
      await page.mouse.up();
      if (restState && activeState && !stylesDiffer(restState, activeState)) {
        ctx.onLog('[InteractiveStates] No visible :active (mousedown) style change on the first sampled button — informational, not flagged (active-state styling is commonly omitted even in well-designed UIs)');
      } else {
        ctx.onLog('[InteractiveStates] Active/pressed state shows a visible style change');
      }
    }
  }
}
