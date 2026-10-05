import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent, isRiskyActionLabel } from './helpers.js';
import { classifyInputRisk } from './forms.js';

// State-transition testing: does the application's actual state match what a user was told
// would happen? The one pattern scoped here is the clearest, most universally-applicable
// case with zero ambiguity about what "correct" means — unlike a filter/sort persistence
// question (where "should this reset on navigation?" genuinely depends on product intent),
// canceling an edit must ALWAYS discard the change, in essentially every real application.
// That makes it safe to assert as a bug, not just an observation, generically, with no
// site-specific knowledge required.
const CANCEL_PATTERN = /^(cancel|discard|close|back)\b/i;
// §17 — the richer multi-step chain from the doc: save a change, THEN make a second edit and
// cancel it — the field should revert to the SAVED value, never past it to the original
// pre-save value (that would silently lose a real save) and never stay at the uncommitted
// second edit (that's the same bug the single-step check above already covers).
const SAVE_PATTERN = /^(save|update|submit|confirm|apply)\b/i;

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string | undefined> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `state-transition-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch {
    return undefined;
  }
}

export async function runStateTransitionCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  // Two independent checks — each does its own field/button discovery, so one bailing out
  // early (e.g. no populated field to probe with) must never skip the other.
  await checkCancelDiscardsUncommittedEdit(page, ctx);
  await checkSaveThenCancelReverts(page, ctx);
}

async function checkCancelDiscardsUncommittedEdit(page: Page, ctx: ExecutorContext): Promise<void> {
  const cancelButton = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: CANCEL_PATTERN })
    .first();

  if ((await cancelButton.count().catch(() => 0)) === 0) {
    ctx.onLog('[StateTransition] No cancel/discard/close control found on this page — nothing to check');
    return;
  }

  const cancelLabel = ((await cancelButton.textContent().catch(() => '')) ?? '').trim().slice(0, 40);

  // Find one safe-classified, currently-populated text field to use as the probe — editing
  // an already-filled field (not an empty one) makes "did the edit get discarded" an
  // unambiguous before/after comparison, not a guess about placeholder vs real value.
  const inputs = await page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):visible, textarea:visible').all();
  let probe: { locator: (typeof inputs)[number]; original: string } | null = null;
  for (const el of inputs.slice(0, 20)) {
    const name = (await el.getAttribute('name').catch(() => '')) || '';
    const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
    const type = (await el.getAttribute('type').catch(() => '')) || 'text';
    const risk = classifyInputRisk(name, placeholder, placeholder || name, type);
    if (risk !== 'safe') continue;
    const currentValue = (await el.inputValue().catch(() => '')) || '';
    if (!currentValue) continue; // need a real original value to detect whether it changed
    probe = { locator: el, original: currentValue };
    break;
  }

  if (!probe) {
    ctx.onLog('[StateTransition] Found a cancel control but no already-populated safe field to probe with — skipping');
    return;
  }

  const probeValue = `QA-cancel-probe-${Date.now()}`.slice(0, 30);
  const pageUrlAtStart = page.url();

  try {
    await probe.locator.fill(probeValue, { timeout: 5000 });
  } catch (err) {
    ctx.onLog(`[StateTransition] Could not fill probe field: ${(err as Error).message.slice(0, 120)}`);
    return;
  }

  const beforeCancelShot = await shot(page, ctx, 'before-cancel');

  if (isRiskyActionLabel(cancelLabel)) {
    // Extremely unlikely for a cancel-shaped label, but stay consistent with the rest of
    // this codebase's discipline rather than special-casing "this one's obviously safe."
    ctx.onLog(`[StateTransition] "${cancelLabel}" matches a risky-action pattern — skipping rather than assuming it's safe`);
    return;
  }

  await cancelButton.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  // Reload to force a fresh read of whatever actually got persisted — re-checking the live
  // in-memory form state alone wouldn't distinguish "cancel cleared the UI back to original"
  // from "cancel silently saved and then reset the form to the (now-changed) saved value."
  const currentUrl = page.url();
  await page.goto(currentUrl === pageUrlAtStart ? pageUrlAtStart : currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  // Re-locate the same field by its original identifying attributes on the reloaded page.
  const nameAttr = await probe.locator.getAttribute('name').catch(() => null);
  const idAttr = await probe.locator.getAttribute('id').catch(() => null);
  const relocateSelector = nameAttr ? `[name="${nameAttr}"]` : idAttr ? `#${idAttr}` : null;

  if (!relocateSelector) {
    ctx.onLog('[StateTransition] Cancel executed, but the probed field has no name/id to re-locate after reload — cannot confirm either way');
    return;
  }

  const reloaded = page.locator(relocateSelector).first();
  if ((await reloaded.count().catch(() => 0)) === 0) {
    ctx.onLog(`[StateTransition] Cancel executed, but "${nameAttr ?? idAttr}" is no longer present after reload — likely navigated away, cannot confirm`);
    return;
  }

  const valueAfterCancel = (await reloaded.inputValue().catch(() => '')) || '';

  if (valueAfterCancel === probeValue) {
    const afterShot = await shot(page, ctx, 'after-cancel-persisted');
    ctx.onFinding({
      severity: 'high',
      area: 'UI-StateTransition',
      title: `"${cancelLabel}" does not discard changes — the edit persists after cancel + reload`,
      steps: [
        `Open ${pageUrlAtStart}`,
        `Change a field's value to "${probeValue}"`,
        `Click "${cancelLabel}" (not Save)`,
        'Reload the page',
      ],
      expected: `Canceling should discard the change — the field should still show its original value ("${probe.original}")`,
      actual: `The field shows "${valueAfterCancel}" — the change made before clicking "${cancelLabel}" was actually persisted`,
      evidence: [beforeCancelShot, afterShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: pageUrlAtStart,
      confidence: 'verified',
      confidenceReason: "Directly compares the field's value after a reload against the exact probe string entered before cancel — an objective match, not inferred.",
    });
  } else if (valueAfterCancel === probe.original) {
    ctx.onLog(`[StateTransition] "${cancelLabel}" correctly discarded the change — field reverted to its original value`);
  } else {
    // Neither the probe value nor the original — something else changed the field (a
    // default, a different record loaded, etc.). Worth a human glance, not a confident bug.
    ctx.onLog(`[StateTransition] "${cancelLabel}": field shows neither the probe value nor the original after reload ("${valueAfterCancel}") — inconclusive, not asserting a finding`);
  }
}

/**
 * §17 — save a change, reload to confirm it persisted, then make a SECOND edit and cancel it.
 * The field should revert to the value that was actually SAVED — not the uncommitted second
 * edit (already covered by the single-step check above) and not the original pre-save value
 * (a distinct, more subtle bug: cancel silently discarding a real, already-committed save).
 * Entirely independent of the check above — runs its own field/button discovery so it isn't
 * affected by whatever that one did or didn't find.
 */
async function checkSaveThenCancelReverts(page: Page, ctx: ExecutorContext): Promise<void> {
  const saveButton = page.locator('button:visible, [role="button"]:visible').filter({ hasText: SAVE_PATTERN }).first();
  const cancelButton = page.locator('button:visible, [role="button"]:visible').filter({ hasText: CANCEL_PATTERN }).first();
  if ((await saveButton.count().catch(() => 0)) === 0 || (await cancelButton.count().catch(() => 0)) === 0) {
    ctx.onLog('[StateTransition] No save+cancel pair found on this page — skipping the save-then-cancel chain');
    return;
  }

  const saveLabel = ((await saveButton.textContent().catch(() => '')) ?? '').trim().slice(0, 40);
  const cancelLabel = ((await cancelButton.textContent().catch(() => '')) ?? '').trim().slice(0, 40);
  if (isRiskyActionLabel(saveLabel) || isRiskyActionLabel(cancelLabel)) {
    ctx.onLog(`[StateTransition] "${saveLabel}"/"${cancelLabel}" matches a risky-action pattern — skipping the save-then-cancel chain`);
    return;
  }

  const inputs = await page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):visible, textarea:visible').all();
  let probeLocator: (typeof inputs)[number] | null = null;
  let nameAttr: string | null = null;
  let idAttr: string | null = null;
  for (const el of inputs.slice(0, 20)) {
    const name = (await el.getAttribute('name').catch(() => '')) || '';
    const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
    const type = (await el.getAttribute('type').catch(() => '')) || 'text';
    if (classifyInputRisk(name, placeholder, placeholder || name, type) !== 'safe') continue;
    if (!name && !(await el.getAttribute('id').catch(() => null))) continue; // need a way to re-locate after reload
    probeLocator = el;
    nameAttr = name || null;
    idAttr = (await el.getAttribute('id').catch(() => null));
    break;
  }
  if (!probeLocator) {
    ctx.onLog('[StateTransition] No safe, re-locatable field found for the save-then-cancel chain — skipping');
    return;
  }
  const relocateSelector = nameAttr ? `[name="${nameAttr}"]` : `#${idAttr}`;
  const pageUrl = page.url();

  const savedValue = `QA-saved-${Date.now()}`.slice(0, 30);
  try {
    await probeLocator.fill(savedValue, { timeout: 5000 });
  } catch (err) {
    ctx.onLog(`[StateTransition] Could not fill probe field for save-then-cancel chain: ${(err as Error).message.slice(0, 120)}`);
    return;
  }
  await saveButton.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await waitForRealContent(page).catch(() => {});

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  let field = page.locator(relocateSelector).first();
  if ((await field.count().catch(() => 0)) === 0) {
    ctx.onLog('[StateTransition] Save-then-cancel chain: field not found after reload — cannot confirm the save persisted, stopping here');
    return;
  }
  const valueAfterSave = (await field.inputValue().catch(() => '')) || '';
  if (valueAfterSave !== savedValue) {
    // The save itself didn't persist — that's data-integrity.ts's territory, not asserted
    // here as a duplicate finding. Nothing further to test in this specific chain.
    ctx.onLog(`[StateTransition] Save-then-cancel chain: "${saveLabel}" did not persist the value ("${valueAfterSave}" vs expected "${savedValue}") — stopping before the cancel step`);
    return;
  }

  // Now make a second, uncommitted edit and cancel it.
  const uncommittedValue = `QA-uncommitted-${Date.now()}`.slice(0, 30);
  try {
    await field.fill(uncommittedValue, { timeout: 5000 });
  } catch {
    return;
  }
  const cancelBtn2 = page.locator('button:visible, [role="button"]:visible').filter({ hasText: CANCEL_PATTERN }).first();
  if ((await cancelBtn2.count().catch(() => 0)) === 0) {
    ctx.onLog('[StateTransition] Save-then-cancel chain: cancel control no longer present after reload — cannot complete the chain');
    return;
  }
  const beforeShot = await shot(page, ctx, 'save-then-cancel-before');
  await cancelBtn2.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  field = page.locator(relocateSelector).first();
  if ((await field.count().catch(() => 0)) === 0) {
    ctx.onLog('[StateTransition] Save-then-cancel chain: field not found after final reload — cannot confirm either way');
    return;
  }
  const finalValue = (await field.inputValue().catch(() => '')) || '';

  if (finalValue === savedValue) {
    ctx.onLog(`[StateTransition] Save-then-cancel chain correct: "${saveLabel}" persisted, then "${cancelLabel}" correctly reverted to the saved value`);
    return;
  }

  const afterShot = await shot(page, ctx, 'save-then-cancel-after');
  if (finalValue === uncommittedValue) {
    ctx.onFinding({
      severity: 'high',
      area: 'UI-StateTransition',
      title: `"${cancelLabel}" does not discard a second, uncommitted edit made after a save`,
      steps: [
        `Open ${pageUrl}`,
        `Change a field to "${savedValue}" and click "${saveLabel}"`,
        `Reload — value persists`,
        `Change the field again to "${uncommittedValue}" (do not save)`,
        `Click "${cancelLabel}"`,
        'Reload',
      ],
      expected: `Canceling the second edit should revert to the last SAVED value ("${savedValue}")`,
      actual: `The field shows "${finalValue}" — the uncommitted second edit was persisted instead of discarded`,
      evidence: [beforeShot, afterShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl,
      confidence: 'verified',
      confidenceReason: "Directly compares the field's value after a reload against the exact probe strings used at each step — an objective match, not inferred.",
    });
  } else {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-StateTransition',
      title: `"${cancelLabel}" after a save reverts past the saved value`,
      steps: [
        `Open ${pageUrl}`,
        `Change a field to "${savedValue}" and click "${saveLabel}"`,
        `Reload — value persists`,
        `Change the field again (do not save)`,
        `Click "${cancelLabel}"`,
        'Reload',
      ],
      expected: `Canceling the second edit should revert to the last SAVED value ("${savedValue}"), not further back`,
      actual: `The field shows "${finalValue}" — neither the saved value nor the uncommitted edit; a previously committed save appears to have been lost`,
      evidence: [beforeShot, afterShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl,
      confidence: 'heuristic',
      confidenceReason: 'The field shows a value other than either probe string used in this chain — could reflect a genuine lost-save bug, or an unrelated default/re-fetch this check does not account for. Verify before treating as confirmed.',
    });
  }
}
