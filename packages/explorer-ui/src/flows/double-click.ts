import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runDoubleClick(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Save")',
  ).first();

  if ((await submit.count()) === 0) {
    ctx.onLog('[Double-click] No submit buttons found');
    return;
  }

  let requestCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' || req.method() === 'PUT') requestCount++;
  });

  await submit.dblclick().catch(() => submit.click());
  await page.waitForTimeout(2000);

  if (requestCount > 1) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-DoubleSubmit',
      title: 'Double-click may trigger duplicate POST requests',
      steps: ['Locate submit button', 'Double-click rapidly'],
      expected: 'Single request or debounced submit',
      actual: `${requestCount} POST/PUT requests observed`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
  }
}
