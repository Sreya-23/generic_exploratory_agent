import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runEmptyStates(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const emptyIndicators = page.locator(
    ':text("No results"), :text("No data"), :text("Nothing here"), :text("Empty"), [class*="empty"]',
  );

  if ((await emptyIndicators.count()) > 0) {
    ctx.onLog('[Empty states] Empty state UI detected — verifying messaging');
    const text = await emptyIndicators.first().textContent();
    if (!text || text.trim().length < 3) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-EmptyStates',
        title: 'Empty state lacks helpful messaging',
        steps: ['Navigate to empty list/view'],
        expected: 'Clear empty state message with guidance',
        actual: 'Empty indicator with minimal or no text',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: false,
      });
    }
  }
}
