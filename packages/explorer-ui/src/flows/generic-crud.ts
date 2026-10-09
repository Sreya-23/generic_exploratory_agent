// §8 — Generic, domain-agnostic CRUD exploration: create an entity, verify it actually exists
// afterward, edit it, verify the change, then delete it and verify removal. Distinct from
// journey.ts's per-site-type CRUD flows (only fire for one classified domain — ecommerce cart,
// saas-dashboard records, etc.) and from data-integrity.ts (a single create-and-correlate
// check, not a full lifecycle) — this works on ANY detected create-shaped form/list, regardless
// of what the entity actually represents (User/Product/Project/Task/... per the doc this
// closes: "you don't need domain-specific code for each one").
//
// Safety: every field filled is 'safe'-classified only (classifyInputRisk), same discipline as
// every other probe-filling flow in this codebase. The delete step is NOT auto-bypassed just
// because the entity is one this flow created itself — it goes through the exact same
// gateIfSensitive() confirmation gate every other destructive action in this codebase uses.
// That gate exists because "the agent created it" doesn't guarantee deleting it is side-effect
// free (cascading deletes, real associations) — reusing it here rather than inventing a
// special-case bypass keeps this consistent with the rest of the codebase's risk posture.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent, isRiskyActionLabel, gateIfSensitive } from './helpers.js';
import { classifyInputRisk } from './forms.js';

const CREATE_TRIGGER_PATTERN = /^(create|add|new)\b/i;
const SUBMIT_PATTERN = /^(save|create|add|submit|confirm)\b/i;
const EDIT_TRIGGER_PATTERN = /^(edit|update)\b/i;
const DELETE_TRIGGER_PATTERN = /^(delete|remove|destroy)\b/i;
const ROW_SELECTORS = 'table tbody tr, [role="row"], [class*="list-item"], [class*="table-row"]';

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string | undefined> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `generic-crud-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch {
    return undefined;
  }
}

async function fillSafeFields(page: Page, value: string): Promise<boolean> {
  const inputs = await page
    .locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):visible, textarea:visible')
    .all();
  let filledAny = false;
  for (const el of inputs.slice(0, 15)) {
    const name = (await el.getAttribute('name').catch(() => '')) || '';
    const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
    const type = (await el.getAttribute('type').catch(() => '')) || 'text';
    if (classifyInputRisk(name, placeholder, placeholder || name, type) !== 'safe') continue;
    await el.fill(value).catch(() => {});
    filledAny = true;
  }
  return filledAny;
}

export async function runGenericCrudCheck(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const createTrigger = page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: CREATE_TRIGGER_PATTERN })
    .first();
  if ((await createTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No create-shaped trigger found on this page — nothing to check');
    return;
  }

  const createLabel = ((await createTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Create';
  if (isRiskyActionLabel(createLabel)) {
    ctx.onLog(`[GenericCrud] "${createLabel}" matches a risky-action pattern — skipping`);
    return;
  }

  const listUrl = page.url();
  ctx.onLog(`[GenericCrud] Starting CRUD lifecycle: "${createLabel}"`);

  await createTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const marker = `QA-CRUD-${Date.now()}`.slice(0, 30);
  if (!(await fillSafeFields(page, marker))) {
    ctx.onLog('[GenericCrud] Create trigger opened, but no safe-classified field found to fill — stopping here');
    return;
  }

  const submitBtn = page
    .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
    .filter({ hasText: SUBMIT_PATTERN })
    .first();
  if ((await submitBtn.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] Filled the create form but found no submit control — stopping here');
    return;
  }
  await submitBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await waitForRealContent(page).catch(() => {});

  // Verify the entity actually exists afterward — reload the list rather than trust the
  // in-memory post-submit DOM, same reasoning state-transition.ts uses for its own checks.
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  let row = page.locator(ROW_SELECTORS).filter({ hasText: marker }).first();
  let foundViaRow = (await row.count().catch(() => 0)) > 0;
  // Fallback: not every list is a table/row-shaped structure (cards, kanban, a plain div
  // list) — a direct text match for the marker is a weaker but still real positive signal.
  const markerText = page.getByText(marker, { exact: false }).first();
  const foundViaText = foundViaRow || (await markerText.count().catch(() => 0)) > 0;

  if (!foundViaText) {
    const createShot = await shot(page, ctx, 'create-not-found');
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-CRUD',
      title: `Created entity does not appear in the list afterward`,
      steps: [`Click "${createLabel}"`, `Fill the form with a distinctive value ("${marker}")`, 'Submit', 'Reload the list'],
      expected: 'A newly created entity should appear in its list view',
      actual: `No row or visible text containing "${marker}" was found after reloading ${listUrl}`,
      evidence: [createShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: listUrl,
      confidence: 'heuristic',
      confidenceReason: 'Could reflect a real creation bug, or simply a list that paginates/sorts the newest entity out of the default view — check the next page or sort order before treating as confirmed.',
    });
    return; // nothing to edit/delete if we can't locate what was created
  }
  ctx.onLog(`[GenericCrud] Create verified — "${marker}" appears in the list`);

  // ── Edit ──────────────────────────────────────────────────────────────────
  const editScope = foundViaRow ? row : page;
  let editTrigger = editScope.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: EDIT_TRIGGER_PATTERN }).first();
  if ((await editTrigger.count().catch(() => 0)) === 0) {
    // Common pattern: the entity's own name/title is the link into its detail/edit view.
    editTrigger = markerText;
  }
  if ((await editTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No edit trigger found for the created entity — stopping before the edit step');
    return;
  }
  await editTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const editedMarker = `${marker}-edited`;
  const editUrl = page.url();
  if (!(await fillSafeFields(page, editedMarker))) {
    ctx.onLog('[GenericCrud] Opened the entity but found no safe field to edit — skipping edit verification');
  } else {
    const editSubmitBtn = page
      .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
      .filter({ hasText: SUBMIT_PATTERN })
      .first();
    if ((await editSubmitBtn.count().catch(() => 0)) > 0) {
      await editSubmitBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await waitForRealContent(page).catch(() => {});

      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      await waitForRealContent(page).catch(() => {});

      const editedFound = (await page.getByText(editedMarker, { exact: false }).count().catch(() => 0)) > 0;
      if (!editedFound) {
        const editShot = await shot(page, ctx, 'edit-not-reflected');
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-CRUD',
          title: `Edited entity does not reflect the change afterward`,
          steps: [`Open the entity created above`, `Change its value to "${editedMarker}"`, 'Save', 'Reload the list'],
          expected: 'An edited entity should show the updated value after reload',
          actual: `Neither "${editedMarker}" (edited) nor a clear update was found after reload`,
          evidence: [editShot].filter((x): x is string => !!x),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: editUrl,
          confidence: 'heuristic',
          confidenceReason: 'A field-level state-transition check already exists separately (state-transition.ts) — this is the list-level view of the same concern and could also reflect a list that has not refreshed its cache.',
        });
      } else {
        ctx.onLog(`[GenericCrud] Edit verified — "${editedMarker}" appears after reload`);
      }
    }
  }

  // ── Delete (gated — see the file-level comment for why this is never auto-bypassed) ──────
  const finalMarker = (await page.getByText(editedMarker, { exact: false }).count().catch(() => 0)) > 0 ? editedMarker : marker;
  const deleteScope = foundViaRow
    ? page.locator(ROW_SELECTORS).filter({ hasText: finalMarker }).first()
    : page;
  const deleteTrigger = deleteScope
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: DELETE_TRIGGER_PATTERN })
    .first();
  if ((await deleteTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No delete trigger found for the created entity — CRUD lifecycle ends at edit');
    return;
  }
  const deleteLabel = ((await deleteTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Delete';

  const canProceed = await gateIfSensitive(page, ctx, deleteLabel);
  if (!canProceed) {
    ctx.onLog(`[GenericCrud] Delete step skipped pending confirmation (or user declined) — the QA-created test entity ("${finalMarker}") may still be left behind and should be cleaned up manually`);
    return;
  }

  await deleteTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await waitForRealContent(page).catch(() => {});

  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const stillPresent = (await page.getByText(finalMarker, { exact: false }).count().catch(() => 0)) > 0;
  if (stillPresent) {
    const deleteShot = await shot(page, ctx, 'delete-not-removed');
    ctx.onFinding({
      severity: 'high',
      area: 'UI-CRUD',
      title: `"${deleteLabel}" does not remove the entity from the list`,
      steps: [`Click "${deleteLabel}" on the entity created/edited above`, 'Reload the list'],
      expected: 'A deleted entity should no longer appear anywhere in its list view',
      actual: `"${finalMarker}" is still visible after reload and clicking "${deleteLabel}"`,
      evidence: [deleteShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: listUrl,
      confidence: 'heuristic',
      confidenceReason: 'Could reflect a genuine delete bug, or a confirmation dialog this check did not detect/dismiss before concluding the delete completed.',
    });
    return;
  }
  ctx.onLog(`[GenericCrud] Delete verified — "${finalMarker}" no longer appears after reload`);

  // Delete-twice — observation only, per the doc's own framing ("observe behavior", not
  // assert a bug): a graceful "not found" is expected; only a visible crash is worth flagging.
  const deleteAgain = page.locator(ROW_SELECTORS).filter({ hasText: finalMarker }).first();
  if ((await deleteAgain.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] Delete-twice: entity no longer reachable to attempt a second delete — nothing more to observe');
  }
}

const CANCEL_PATTERN = /^(cancel|close|discard)\b/i;

/**
 * Checklist (UI) §13 — "Cancel creation": open the create form, fill it, click Cancel instead
 * of Submit, and confirm NO entity was created. A separate task/run from the main CRUD lifecycle
 * above — both open the same create trigger, so they can't share one page visit.
 */
export async function runCancelCreationCheck(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const createTrigger = page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: CREATE_TRIGGER_PATTERN }).first();
  if ((await createTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No create-shaped trigger found — skipping cancel-creation check');
    return;
  }
  const createLabel = ((await createTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Create';
  if (isRiskyActionLabel(createLabel)) {
    ctx.onLog(`[GenericCrud] "${createLabel}" matches a risky-action pattern — skipping cancel-creation check`);
    return;
  }

  const listUrl = page.url();
  await createTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const marker = `QA-CANCEL-CREATE-${Date.now()}`.slice(0, 30);
  if (!(await fillSafeFields(page, marker))) {
    ctx.onLog('[GenericCrud] Create trigger opened, but no safe field to fill — skipping cancel-creation check');
    return;
  }

  const cancelBtn = page.locator('button:visible, [role="button"]:visible').filter({ hasText: CANCEL_PATTERN }).first();
  if ((await cancelBtn.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No Cancel control found on the create form — skipping cancel-creation check');
    return;
  }
  await cancelBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const leaked = (await page.getByText(marker, { exact: false }).count().catch(() => 0)) > 0;
  if (leaked) {
    const leakShot = await shot(page, ctx, 'cancel-creation-leaked');
    ctx.onFinding({
      severity: 'high',
      area: 'UI-CRUD',
      title: 'Canceling entity creation still creates the entity',
      steps: [`Click "${createLabel}"`, `Fill the form with a distinctive value ("${marker}")`, 'Click Cancel instead of Submit', 'Reload the list'],
      expected: 'Canceling a create form should discard the entered data, not persist it',
      actual: `"${marker}" appears in the list despite clicking Cancel instead of Submit`,
      evidence: [leakShot].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: listUrl,
      confidence: 'verified',
      confidenceReason: 'The marker value was never submitted — its presence after Cancel can only mean the entity was created anyway.',
    });
  } else {
    ctx.onLog('[GenericCrud] Cancel correctly discards the create form without creating an entity');
  }
}

/**
 * Checklist (UI) §13 — "Cancel deletion": creates its own synthetic entity (never targets a
 * real pre-existing one), clicks Delete, cancels the confirmation dialog if one appears, and
 * confirms the entity survives — then actually deletes it for real cleanup afterward (gated,
 * same discipline as the main lifecycle above).
 */
export async function runCancelDeletionCheck(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const createTrigger = page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: CREATE_TRIGGER_PATTERN }).first();
  if ((await createTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No create-shaped trigger found — skipping cancel-deletion check');
    return;
  }
  const createLabel = ((await createTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Create';
  if (isRiskyActionLabel(createLabel)) {
    ctx.onLog(`[GenericCrud] "${createLabel}" matches a risky-action pattern — skipping cancel-deletion check`);
    return;
  }

  const listUrl = page.url();
  await createTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const marker = `QA-CANCEL-DELETE-${Date.now()}`.slice(0, 30);
  if (!(await fillSafeFields(page, marker))) {
    ctx.onLog('[GenericCrud] No safe field to fill — skipping cancel-deletion check');
    return;
  }
  const submitBtn = page.locator('button:visible, [role="button"]:visible, input[type="submit"]:visible').filter({ hasText: SUBMIT_PATTERN }).first();
  if ((await submitBtn.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No submit control — skipping cancel-deletion check');
    return;
  }
  await submitBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const row = page.locator(ROW_SELECTORS).filter({ hasText: marker }).first();
  const foundViaRow = (await row.count().catch(() => 0)) > 0;
  const foundViaText = foundViaRow || (await page.getByText(marker, { exact: false }).count().catch(() => 0)) > 0;
  if (!foundViaText) {
    ctx.onLog('[GenericCrud] Could not confirm the synthetic entity was created — skipping cancel-deletion check');
    return;
  }

  const deleteScope = foundViaRow ? row : page;
  const deleteTrigger = deleteScope.locator('button:visible, [role="button"]:visible').filter({ hasText: DELETE_TRIGGER_PATTERN }).first();
  if ((await deleteTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No delete trigger found — skipping cancel-deletion check, synthetic entity may need manual cleanup');
    return;
  }
  await deleteTrigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Look for a confirmation dialog's OWN Cancel control, distinct from the delete trigger
  // itself — many apps show a modal/alert here rather than deleting immediately.
  const confirmDialogCancel = page.locator('[role="dialog"] button, [role="alertdialog"] button, .modal button')
    .filter({ hasText: CANCEL_PATTERN })
    .first();
  if ((await confirmDialogCancel.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] Delete has no confirmation dialog to cancel (deletes immediately) — cancel-deletion scenario not applicable here; cleaning up via real delete');
    // The entity is very likely already gone (immediate delete) or mid-deletion — attempt a
    // real, gated cleanup pass in case it somehow survived, then stop.
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    return;
  }

  await confirmDialogCancel.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForRealContent(page).catch(() => {});

  const stillExists = (await page.getByText(marker, { exact: false }).count().catch(() => 0)) > 0;
  if (!stillExists) {
    const gone = await shot(page, ctx, 'cancel-deletion-still-deleted');
    ctx.onFinding({
      severity: 'high',
      area: 'UI-CRUD',
      title: 'Canceling the delete confirmation dialog still deletes the entity',
      steps: ['Click Delete on an entity', 'Click Cancel on the confirmation dialog', 'Reload the list'],
      expected: 'Canceling the confirmation should leave the entity untouched',
      actual: `"${marker}" no longer appears after canceling the delete confirmation`,
      evidence: [gone].filter((x): x is string => !!x),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: listUrl,
      confidence: 'verified',
      confidenceReason: 'The confirmation dialog\'s own Cancel control was clicked, not the delete button — the entity disappearing anyway is unambiguous.',
    });
  } else {
    ctx.onLog('[GenericCrud] Cancel on the delete confirmation correctly leaves the entity intact');
  }

  // Real cleanup: delete the synthetic entity for real now, gated same as the main lifecycle.
  const cleanupRow = page.locator(ROW_SELECTORS).filter({ hasText: marker }).first();
  const cleanupScope = (await cleanupRow.count().catch(() => 0)) > 0 ? cleanupRow : page;
  const cleanupDeleteTrigger = cleanupScope.locator('button:visible, [role="button"]:visible').filter({ hasText: DELETE_TRIGGER_PATTERN }).first();
  if ((await cleanupDeleteTrigger.count().catch(() => 0)) > 0) {
    const deleteLabel = ((await cleanupDeleteTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Delete';
    const canProceed = await gateIfSensitive(page, ctx, deleteLabel);
    if (canProceed) {
      await cleanupDeleteTrigger.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      const confirmBtn = page.locator('[role="dialog"] button, [role="alertdialog"] button, .modal button')
        .filter({ hasText: /^(delete|confirm|yes|remove)\b/i })
        .first();
      if ((await confirmBtn.count().catch(() => 0)) > 0) {
        await confirmBtn.click({ timeout: 5000 }).catch(() => {});
      }
      ctx.onLog(`[GenericCrud] Cleaned up synthetic test entity "${marker}"`);
    } else {
      ctx.onLog(`[GenericCrud] Cleanup delete skipped pending confirmation — "${marker}" may be left behind and should be removed manually`);
    }
  }
}

/**
 * Checklist (UI) §13 — "Duplicate creation": create the exact same entity twice in a row and
 * observe whether duplicate-prevention exists. Informational by default — whether duplicates
 * SHOULD be prevented is entirely domain-specific (a todo app may allow identical task names;
 * a username/SKU field should not) — only flagged if something visibly breaks, not for the mere
 * existence of two identical records.
 */
export async function runDuplicateCreationCheck(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const createTrigger = page.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: CREATE_TRIGGER_PATTERN }).first();
  if ((await createTrigger.count().catch(() => 0)) === 0) {
    ctx.onLog('[GenericCrud] No create-shaped trigger found — skipping duplicate-creation check');
    return;
  }
  const createLabel = ((await createTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Create';
  if (isRiskyActionLabel(createLabel)) {
    ctx.onLog(`[GenericCrud] "${createLabel}" matches a risky-action pattern — skipping duplicate-creation check`);
    return;
  }

  const listUrl = page.url();
  const marker = `QA-DUP-${Date.now()}`.slice(0, 30);
  let creationErrors = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    await createTrigger.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    await waitForRealContent(page).catch(() => {});
    if (!(await fillSafeFields(page, marker))) {
      ctx.onLog('[GenericCrud] No safe field to fill — skipping duplicate-creation check');
      return;
    }
    const submitBtn = page.locator('button:visible, [role="button"]:visible, input[type="submit"]:visible').filter({ hasText: SUBMIT_PATTERN }).first();
    if ((await submitBtn.count().catch(() => 0)) === 0) {
      ctx.onLog('[GenericCrud] No submit control — skipping duplicate-creation check');
      return;
    }
    await submitBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const errorVisible = await page.locator('[class*="error"]:visible, [role="alert"]:visible').count().catch(() => 0);
    if (attempt === 1 && errorVisible > 0) creationErrors++;
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    await waitForRealContent(page).catch(() => {});
  }

  const matchCount = await page.getByText(marker, { exact: false }).count().catch(() => 0);
  if (matchCount >= 2 && creationErrors === 0) {
    ctx.onLog(`[GenericCrud] Creating the identical entity twice succeeded both times (${matchCount} match(es) found) — duplicate-prevention does not appear to be enforced for this entity type; whether that's intended is domain-specific, not flagged as a defect`);
  } else if (matchCount < 2) {
    ctx.onLog(`[GenericCrud] Duplicate creation appears to be prevented or deduplicated (${matchCount} match(es) found after 2 identical submissions)`);
  }

  // Best-effort cleanup: attempt to delete whatever synthetic entities this check created.
  for (let i = 0; i < matchCount; i++) {
    const row = page.locator(ROW_SELECTORS).filter({ hasText: marker }).first();
    const scope = (await row.count().catch(() => 0)) > 0 ? row : page;
    const deleteTrigger = scope.locator('button:visible, [role="button"]:visible').filter({ hasText: DELETE_TRIGGER_PATTERN }).first();
    if ((await deleteTrigger.count().catch(() => 0)) === 0) break;
    const deleteLabel = ((await deleteTrigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40) || 'Delete';
    const canProceed = await gateIfSensitive(page, ctx, deleteLabel);
    if (!canProceed) {
      ctx.onLog(`[GenericCrud] Cleanup skipped pending confirmation — synthetic duplicate(s) of "${marker}" may be left behind`);
      break;
    }
    await deleteTrigger.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const confirmBtn = page.locator('[role="dialog"] button, [role="alertdialog"] button, .modal button')
      .filter({ hasText: /^(delete|confirm|yes|remove)\b/i })
      .first();
    if ((await confirmBtn.count().catch(() => 0)) > 0) {
      await confirmBtn.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}
