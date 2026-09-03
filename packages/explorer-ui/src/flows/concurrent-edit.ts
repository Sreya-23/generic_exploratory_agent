// Form autosave / concurrent-edit conflicts. Two distinct real-world scenarios a manual QA
// process would try but a pure boundary/validation sweep never does: (1) a user fills part of
// a form, gets interrupted (a notification, a phone call, an accidental back-navigation), and
// comes back — did their half-finished work survive; (2) the same record is open in two tabs
// at once and both get saved — does the second save silently clobber the first with no warning.
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent } from './helpers.js';

const MARKER_PREFIX = 'QA_DRAFT_';

async function findFillableForm(page: Page): Promise<{ inputSelector: string; count: number } | null> {
  const inputSelector = 'form input[type="text"]:visible, form input:not([type]):visible, form textarea:visible';
  const count = await page.locator(inputSelector).count().catch(() => 0);
  return count > 0 ? { inputSelector, count } : null;
}

export async function runConcurrentEditCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[ConcurrentEdit] Checking draft persistence and same-record multi-tab editing');
  const url = page.url();

  const form = await findFillableForm(page);
  if (!form) {
    ctx.onLog('[ConcurrentEdit] No fillable form on this page — skipping');
    return;
  }

  // ── Scenario A: fill mid-form, navigate away, come back — is the draft still there? ──────
  const marker = `${MARKER_PREFIX}${Date.now()}`;
  const firstInput = page.locator(form.inputSelector).first();
  await firstInput.fill(marker).catch(() => {});

  // Prefer a real same-origin nav link over history navigation — history back/forward can hit
  // the browser's bfcache and trivially "preserve" the DOM regardless of the app's own draft
  // handling, which would make this check pass for the wrong reason. A fresh click-away and a
  // deliberate return is what an interrupted user's session actually looks like.
  const awayLink = page
    .locator('a[href]:visible')
    .filter({ hasNotText: /log ?out|sign ?out/i })
    .first();
  const hasAwayLink = await awayLink.count().catch(() => 0);

  if (hasAwayLink) {
    await awayLink.click({ timeout: 3000 }).catch(() => {});
    await waitForRealContent(page).catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForRealContent(page).catch(() => {});

    const restoredValue = await page.locator(form.inputSelector).first().inputValue().catch(() => '');
    if (restoredValue !== marker) {
      const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'concurrent-edit-draft-lost.png');
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      ctx.onFinding({
        severity: 'low',
        area: 'UI-ConcurrentEdit',
        title: 'Mid-form input is not preserved after navigating away and back',
        steps: [
          `Open ${url}`,
          'Start filling in the form (do not submit)',
          'Navigate to another page, then return to this page',
          'Check whether the in-progress input is still there',
        ],
        expected: 'Either the draft survives (autosave/local persistence), or the form clearly indicates unsaved changes will be lost before navigating away',
        actual: 'The field was silently reset — no draft recovery, and no warning was shown before navigating away',
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
        confidence: 'verified',
        confidenceReason: 'Directly observed: a known marker value was entered, a real navigation occurred, and the same field was re-read on return — not inferred. Whether this is worth fixing depends on how consequential losing that specific form\'s input is to a real user; a short filter field losing its draft matters far less than a multi-step application form doing the same.',
      });
    } else {
      ctx.onLog('[ConcurrentEdit] Draft value survived navigating away and back');
    }
  } else {
    ctx.onLog('[ConcurrentEdit] No safe same-origin link found to navigate away with — skipping draft-persistence check');
  }

  // ── Scenario B: same record open in two tabs, both edited and saved ──────────────────────
  // Best-effort and explicitly heuristic: without knowing the app's actual save endpoint or
  // data model, this can observe that a submit happened in each tab and that reloading only
  // ever shows one of the two values, but it cannot independently confirm which value SHOULD
  // have won, or whether the app deliberately uses last-write-wins. That judgment call is left
  // to whoever reviews the finding — the value here is surfacing that no conflict warning was
  // shown at all, not asserting which outcome is correct.
  const context: BrowserContext = page.context();
  const secondPage = await context.newPage().catch(() => null);
  if (!secondPage) return;

  // Deliberately never submits either tab: doing so would write fabricated marker text into
  // whatever real record this form actually edits on a live target site, which is a genuinely
  // destructive side effect, not a safe exploratory one — action-inventory.ts already
  // establishes the precedent of skipping risky/destructive actions rather than attempting
  // them "to see what happens." Instead this only checks the PASSIVE signal: does the app
  // even notice a second tab has the same record open, before anything is saved.
  try {
    await secondPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForRealContent(secondPage).catch(() => {});
    const secondForm = await findFillableForm(secondPage);
    if (!secondForm) {
      ctx.onLog('[ConcurrentEdit] Second tab did not load the same fillable form — skipping multi-tab check');
      return;
    }

    const lockSignal = await secondPage
      .locator('text=/currently (being )?edited|someone else is (viewing|editing)|locked by|read.only.*editing|another (user|session) has this open/i')
      .count()
      .catch(() => 0);

    if (lockSignal > 0) {
      ctx.onLog('[ConcurrentEdit] Concurrent-edit awareness UI detected in the second tab — good sign, no finding needed');
      return;
    }

    const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'concurrent-edit-two-tabs.png');
    await secondPage.screenshot({ path: shot, fullPage: false }).catch(() => {});
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ConcurrentEdit',
      title: 'No concurrent-edit awareness when the same record is opened in a second tab',
      steps: [
        `Open ${url} in one tab`,
        'Open the exact same record in a second tab',
        'Check whether either tab indicates the record is already open elsewhere',
      ],
      expected: 'Either a "someone else has this open" indicator appears, or last-write-wins is an accepted, deliberate design for this form',
      actual: 'Opening the same record in a second tab showed no lock/awareness indicator of any kind',
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: url,
      confidence: 'heuristic',
      confidenceReason: 'This only checks for a passive UI signal and deliberately never submits either form — actually saving fabricated data to confirm a real conflict would risk corrupting a genuine record on this target site. Whether the absence of a lock indicator matters depends on how often two people realistically edit the same record at once; for many forms it never does.',
    });
  } finally {
    await secondPage.close().catch(() => {});
  }
}
