import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { runFormValidation } from './forms.js';

export async function runInputBoundary(
  page: Page,
  ctx: ExecutorContext,
  task: FlowTask,
): Promise<void> {
  await runFormValidation(page, ctx, task);
}
