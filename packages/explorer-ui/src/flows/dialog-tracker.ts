import type { Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';

// A22 — Unexpected native dialogs. Playwright silently auto-dismisses alert()/confirm()/prompt()
// when no listener is attached, so before this every native dialog the app raised — including
// ones that ARE the bug ("Sorting is broken!", "Error: undefined") — vanished without a trace.
// Attached to every task's page (like js-error-tracker), this records each dialog and turns the
// ones whose text reads like a failure into a finding. Benign dialogs ("Item saved") are only
// logged. Behaviour toward the app is unchanged: dialogs are still dismissed (a confirm() is
// answered "Cancel", which is also the safe answer for any destructive confirm), except
// beforeunload, which is accepted so navigation never hangs.

const ERRORISH =
  /\b(error|broken|fail(ed|ure)?|exception|wrong|invalid|undefined|null|nan|cannot|can't|could not|unable|oops|sorry|not (working|available|supported|found)|crash|denied|forbidden|timeout|timed out)\b/i;

const seenBySession = new Map<string, Set<string>>();

export function isErrorishDialog(message: string): boolean {
  return ERRORISH.test(message);
}

export function attachDialogTracking(page: Page, ctx: ExecutorContext): void {
  if (!seenBySession.has(ctx.sessionId)) seenBySession.set(ctx.sessionId, new Set());
  const seen = seenBySession.get(ctx.sessionId)!;

  page.on('dialog', async (dialog) => {
    const type = dialog.type();
    const message = dialog.message().trim();
    const url = page.url();
    try {
      if (type === 'beforeunload') await dialog.accept();
      else await dialog.dismiss();
    } catch {
      // Another listener (or a flow) already handled it — nothing to do.
    }
    if (type === 'beforeunload') return;

    const key = `${type}|${message.slice(0, 200)}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (!isErrorishDialog(message)) {
      ctx.onLog(`[Dialog] Browser ${type} on ${url}: "${message.slice(0, 120)}" (looks benign — not reported)`);
      return;
    }
    ctx.onLog(`[Dialog] Browser ${type} reports a problem on ${url}: "${message.slice(0, 120)}"`);
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-Dialog',
      title: `App shows an error pop-up: "${message.slice(0, 80)}"`,
      steps: [`Open ${url}`, 'Repeat the action the agent was performing on this page (see task)', `A native ${type}() dialog appears`],
      expected: 'Actions complete without the app raising an error pop-up',
      actual: `Native ${type}() dialog with text: "${message.slice(0, 300)}"`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: url,
      confidence: 'verified',
      confidenceReason: 'The page itself raised a native dialog whose text describes a failure.',
    });
  });
}

export function clearDialogTracking(sessionId: string): void {
  seenBySession.delete(sessionId);
}
