import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const TRIGGER_SELECTOR = 'button:has-text("Open"), button:has-text("Modal"), [data-toggle="modal"], [aria-haspopup="dialog"]';
const DIALOG_SELECTOR = '[role="dialog"], .modal, [aria-modal="true"]';
const X_CLOSE_SELECTOR = '[aria-label*="close" i], [aria-label*="dismiss" i], [title*="close" i], button:has-text("×"), button:has-text("✕"), button[class*="close" i]';
const CANCEL_CLOSE_SELECTOR = 'button:has-text("Cancel")';

async function openModal(page: Page): Promise<boolean> {
  const trigger = page.locator(TRIGGER_SELECTOR).first();
  if ((await trigger.count()) === 0) return false;
  await trigger.click().catch(() => {});
  await page.waitForTimeout(500);
  return (await page.locator(DIALOG_SELECTOR).count()) > 0;
}

function isOpen(page: Page, dialog = page.locator(DIALOG_SELECTOR).first()) {
  return dialog.isVisible().catch(() => false);
}

/**
 * Checklist (UI) §6 — Modals/Dialogues. Previously this file was 40 lines testing exactly one
 * thing (Escape closes the modal). Expanded to cover the other explicit close mechanisms the
 * checklist names (X, Cancel, click-outside), reopen idempotency, and whether the background
 * is actually blocked while the modal is open — each as its own fresh open/close cycle, since
 * testing one close method can leave the modal in a state that invalidates testing the next.
 */
export async function runModalLifecycle(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  if (!(await openModal(page))) {
    ctx.onLog('[Modals] No modal triggers found');
    return;
  }

  const dialog = page.locator(DIALOG_SELECTOR).first();

  // ── Background blocked while modal is open ───────────────────────────────────────────────
  // A modal with no overlay/backdrop element at all is a real, common bug (background stays
  // interactive) — this only checks for the PRESENCE of a blocking layer, not individual
  // element click-through, since the latter varies too much by implementation to assert
  // generically without false positives.
  const hasOverlay = (await page.locator('[class*="overlay" i], [class*="backdrop" i], .modal-backdrop').count()) > 0;
  if (!hasOverlay) {
    ctx.onLog('[Modals] No overlay/backdrop element detected behind the open modal — background may remain clickable; not asserted as a confirmed bug (some implementations block clicks via other means, e.g. a full-page fixed-position dialog)');
  }

  // ── Escape ────────────────────────────────────────────────────────────────────────────────
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await isOpen(page, dialog)) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Modals',
      title: 'Modal does not close on Escape key',
      steps: ['Open modal', 'Press Escape'],
      expected: 'Modal closes',
      actual: 'Modal remains visible',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
    });
    // Force it closed (best-effort) so the remaining checks aren't blocked by a stuck modal.
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    ctx.onLog('[Modals] Escape correctly closes the modal');
  }

  // ── Close using X ─────────────────────────────────────────────────────────────────────────
  if (await openModal(page)) {
    const xBtn = dialog.locator(X_CLOSE_SELECTOR).first();
    if ((await xBtn.count()) > 0 && (await xBtn.isVisible().catch(() => false))) {
      await xBtn.click().catch(() => {});
      await page.waitForTimeout(300);
      if (await isOpen(page, dialog)) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Modals',
          title: 'Modal does not close when its X/close control is clicked',
          steps: ['Open modal', 'Click the X / close icon'],
          expected: 'Modal closes',
          actual: 'Modal remains visible after clicking a control specifically labeled/styled as "close"',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          confidence: 'verified',
          confidenceReason: 'The clicked control is unambiguously a close affordance (aria-label/title/class containing "close", or an × glyph) — there is no legitimate reason for it not to close the modal.',
        });
      } else {
        ctx.onLog('[Modals] X/close control correctly closes the modal');
      }
    } else {
      ctx.onLog('[Modals] No distinct X/close icon control found inside the modal');
    }
  }

  // ── Close using Cancel ────────────────────────────────────────────────────────────────────
  if (await openModal(page)) {
    const cancelBtn = dialog.locator(CANCEL_CLOSE_SELECTOR).first();
    if ((await cancelBtn.count()) > 0 && (await cancelBtn.isVisible().catch(() => false))) {
      await cancelBtn.click().catch(() => {});
      await page.waitForTimeout(300);
      if (await isOpen(page, dialog)) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-Modals',
          title: 'Modal does not close when Cancel is clicked',
          steps: ['Open modal', 'Click "Cancel"'],
          expected: 'Modal closes without applying any changes',
          actual: 'Modal remains visible after clicking Cancel',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          confidence: 'verified',
          confidenceReason: 'A button explicitly labeled "Cancel" inside an open dialog is unambiguously expected to close it.',
        });
      } else {
        ctx.onLog('[Modals] Cancel correctly closes the modal');
      }
    } else {
      ctx.onLog('[Modals] No "Cancel" button found inside the modal');
    }
  }

  // ── Click outside (backdrop) ──────────────────────────────────────────────────────────────
  // Observational only: many modals intentionally do NOT close on backdrop click (confirmation
  // dialogs, anything with unsaved-work risk) — this is a legitimate design choice, not a bug,
  // so the outcome is logged either way rather than asserted.
  if (await openModal(page)) {
    const box = await dialog.boundingBox().catch(() => null);
    if (box) {
      // Click near a page corner, clear of the dialog's own bounding box.
      await page.mouse.click(5, 5).catch(() => {});
      await page.waitForTimeout(300);
      const stillOpen = await isOpen(page, dialog);
      ctx.onLog(`[Modals] Click-outside-to-dismiss: modal ${stillOpen ? 'stayed open' : 'closed'} — both are valid designs, not asserted as a defect`);
      if (stillOpen) await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // ── Reopen idempotency ────────────────────────────────────────────────────────────────────
  if (await openModal(page)) {
    const opensCleanly = await isOpen(page, dialog);
    if (!opensCleanly) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-Modals',
        title: 'Modal does not reopen correctly after being closed once',
        steps: ['Open modal', 'Close it', 'Open it again'],
        expected: 'The modal should open the same way every time',
        actual: 'The modal did not visibly open on the second attempt',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Could reflect a timing issue in this check rather than a real reopen bug — retry to confirm before treating as confirmed.',
      });
    } else {
      ctx.onLog('[Modals] Modal reopens correctly after being closed');
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
}
