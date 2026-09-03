import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Real browsers draw their own password-manager/autofill icon inside email/password fields —
// that icon is browser chrome, not part of the page, so it can't be screenshotted or measured
// directly through Playwright. This is a geometry-based heuristic instead: a custom icon sitting
// right at the field's edge with too little reserved padding is AT RISK of visually colliding
// with a real browser's autofill icon — worth a human spot-check, not a certain defect.
export async function runAutofillOverlapCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog(
    "[AutofillOverlap] Checking email/password fields for custom icons that may collide with the browser's native autofill icon",
  );

  const atRisk = await page
    .evaluate(() => {
      const results: { selector: string; rightPadding: number }[] = [];
      const inputs = Array.from(
        document.querySelectorAll(
          'input[type="email"], input[type="password"], input[autocomplete*="email"], input[autocomplete*="password"], input[autocomplete*="username"]',
        ),
      );
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;

        const rightPadding = parseFloat(style.paddingRight) || 0;
        const wrapper = el.parentElement;
        if (!wrapper) continue;

        const iconLike = Array.from(wrapper.querySelectorAll('svg, i, [class*="icon"]')).find((icon) => {
          const iRect = (icon as Element).getBoundingClientRect();
          return iRect.width > 0 && iRect.right >= rect.right - 40 && iRect.right <= rect.right + 4;
        });

        if (iconLike && rightPadding < 36) {
          results.push({
            selector: el.name || el.id || el.type,
            rightPadding,
          });
        }
      }
      return results.slice(0, 8);
    })
    .catch(() => [] as { selector: string; rightPadding: number }[]);

  if (atRisk.length === 0) {
    ctx.onLog('[AutofillOverlap] No at-risk email/password fields found');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'autofill-overlap.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  ctx.onFinding({
    severity: 'low',
    area: 'UI-Autofill',
    title: `${atRisk.length} email/password field(s) may visually collide with the browser's native autofill icon`,
    steps: [
      'Open this page in a real Chrome/Firefox profile with saved credentials',
      `Focus the field(s): ${atRisk.map((f) => f.selector).join(', ')}`,
      "Check whether the browser's own autofill/password icon overlaps the field's custom icon",
    ],
    expected: "Enough right-padding is reserved so the browser's native autofill icon doesn't overlap custom field icons",
    actual: `Field(s) with a custom icon near the right edge and only ${atRisk
      .map((f) => f.rightPadding)
      .join('/')}px of right padding (native icons typically need ~36-40px): ${atRisk.map((f) => f.selector).join(', ')}`,
    evidence: [shot],
    reproRate: 'Heuristic — verify visually in a real browser with saved credentials',
    automationCandidate: false,
    pageUrl: page.url(),
  });
}
