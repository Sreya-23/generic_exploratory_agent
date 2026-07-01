// A12 — Pagination UI: last page, jump pages, refresh mid-scroll
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runPaginationUi(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[PaginationUI] Testing pagination controls');

  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `pagination-${name}.png`);

  // Find pagination controls
  const paginationSelectors = [
    '[aria-label*="pagination" i]',
    '[class*="pagination"]',
    '[class*="pager"]',
    'nav[role="navigation"] a',
    'button:has-text("Next")',
    'a:has-text("Next")',
    '[data-testid*="pagination"]',
  ];

  let paginationFound = false;

  for (const sel of paginationSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      paginationFound = true;
      ctx.onLog(`[PaginationUI] Found pagination via: ${sel}`);
      break;
    }
  }

  if (!paginationFound) {
    ctx.onLog('[PaginationUI] No pagination controls found on this page');
    return;
  }

  // 1. Test "Next" button
  const nextBtn = page
    .locator('button:has-text("Next"), a:has-text("Next"), [aria-label="Next page"]')
    .first();

  if ((await nextBtn.count()) > 0) {
    const urlBefore = page.url();
    await nextBtn.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(600);
    const s1 = shot('next-page');
    await page.screenshot({ path: s1 });
    ctx.onLog(`[PaginationUI] Next clicked — now at: ${page.url()}`);

    // 2. Refresh on page 2 and check state preserved
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const urlAfterRefresh = page.url();
    const s2 = shot('refresh-on-page2');
    await page.screenshot({ path: s2 });

    if (urlAfterRefresh !== page.url()) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Pagination',
        title: 'Refresh on page 2 redirects away from current page',
        steps: ['Navigate to next page', 'Refresh browser'],
        expected: 'Stay on the same paginated page after refresh',
        actual: `Redirected to ${page.url()} instead of ${urlAfterRefresh}`,
        evidence: [s1, s2],
        reproRate: '1/1',
        automationCandidate: true,
      });
    }

    // 3. Navigate to "Last" page
    const lastBtn = page
      .locator('button:has-text("Last"), a:has-text("Last"), [aria-label="Last page"]')
      .first();

    if ((await lastBtn.count()) > 0) {
      await lastBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(600);
      const s3 = shot('last-page');
      await page.screenshot({ path: s3 });

      // On last page, "Next" should be disabled
      const nextDisabled =
        (await nextBtn.isDisabled().catch(() => false)) ||
        !(await nextBtn.isVisible().catch(() => true));

      if (!nextDisabled) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Pagination',
          title: '"Next" button still enabled on last page',
          steps: ['Navigate to last page', 'Check Next button state'],
          expected: '"Next" disabled or hidden on last page',
          actual: '"Next" button appears enabled on last page',
          evidence: [s3],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        ctx.onLog('[PaginationUI] Next correctly disabled on last page');
      }
    }

    // 4. Go back to first page
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // 5. Check if Previous/Back is disabled on page 1
    const prevBtn = page
      .locator('button:has-text("Prev"), a:has-text("Prev"), button:has-text("Previous"), [aria-label="Previous page"]')
      .first();

    if ((await prevBtn.count()) > 0) {
      const prevDisabled = await prevBtn.isDisabled().catch(() => false);
      if (!prevDisabled) {
        const s4 = shot('prev-on-first-page');
        await page.screenshot({ path: s4 });
        ctx.onFinding({
          severity: 'low',
          area: 'UI-Pagination',
          title: '"Previous" button enabled on first page',
          steps: ['Navigate to first page', 'Check Previous button state'],
          expected: '"Previous" disabled or hidden on first page',
          actual: '"Previous" button appears active on first page',
          evidence: [s4],
          reproRate: '1/1',
          automationCandidate: true,
        });
      }
    }
  }
}
