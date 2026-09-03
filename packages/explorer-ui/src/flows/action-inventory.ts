import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type {
  ActionInventoryEntry,
  ActionInventoryResult,
  ExecutorContext,
  FlowTask,
} from '@qa/shared';
import { isRiskyActionLabel, explorationBreadth, describeElement, elementFingerprint } from './helpers.js';

/**
 * Action Inventory — the "explore every button, not just every link" pass.
 *
 * navigation.ts's BFS only enqueues elements with an href; anything that acts via a click
 * handler (icon-only buttons, menu items, tabs) never gets visited or recorded at all. This
 * flow closes that gap: it finds every distinct button/icon-button/menu-item/tab on the
 * current page (and, depth permitting, a few more same-origin pages), clicks each one that
 * isn't risky, and records what happened — producing a concrete "N action elements found, M
 * produced a visible effect" artifact for the report, plus findings for the specific outcomes
 * worth a human's attention (dead buttons, crashes).
 */
// Widened beyond semantic button/role elements: real <a href> links (a large share of what a
// user can actually click, previously invisible to this flow entirely), plus [onclick] and
// [tabindex="0"] — the two markers custom, non-semantic clickable <div>/<span> elements
// (common in React/Vue apps) use in place of a real button/role. mailto:/tel: links are
// excluded — clicking them just hands off to the OS mail/phone app, not a page-level result
// this flow can meaningfully observe. tabindex="-1" is also excluded everywhere: it's the
// standard convention for "programmatically focusable only, not part of normal interaction" —
// e.g. Amazon's keyboard-shortcut helper links (real href, real click handler, but kept
// permanently off-screen until triggered by a keyboard shortcut). Confirmed via live repro:
// clicking one of these hangs forever with Playwright reporting "element is outside of the
// viewport" even after scrolling, since nothing ever brings it on-screen for a mouse click —
// a real quirk of that widget, not a testable page action.
const CANDIDATE_SELECTOR =
  'button:not([tabindex="-1"]), [role="button"]:not([tabindex="-1"]), input[type="button"], input[type="submit"], ' +
  '[role="menuitem"]:not([tabindex="-1"]), [role="tab"]:not([tabindex="-1"]), ' +
  'a[href]:not([href^="mailto:"]):not([href^="tel:"]):not([tabindex="-1"]), [onclick]:not([tabindex="-1"]), [tabindex="0"]';
const MAX_CANDIDATES_PER_PAGE = 40;

interface PageState {
  url: string;
  dialogCount: number;
  bodyLength: number;
}

interface PageScanResult {
  entries: ActionInventoryEntry[];
  noEffectLabels: string[];
  tested: number;
  skippedRisky: number;
  totalFound: number;
}

// A raw 150-char head-slice of a Playwright click error is useless for the actionability
// timeouts this flow hits most: the message opens with the full CSS selector text (often
// 150+ chars on its own for CANDIDATE_SELECTOR), burying the actual reason — "element is
// outside of the viewport", "intercepted by another element", etc. — which always appears
// near the END of the call log. Keep the one-line summary plus the tail of the log instead.
function summarizeClickError(message: string): string {
  const firstLine = message.split('\n')[0]?.trim() ?? message;
  const tail = message.slice(-300).trim();
  return tail.startsWith(firstLine) ? tail : `${firstLine}\n…\n${tail}`;
}

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string | undefined> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `action-inventory-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch {
    // A screenshot can fail for the same reason the click just did (page mid-navigation,
    // unresponsive) — returning the intended path anyway would claim evidence that was never
    // actually written to disk.
    return undefined;
  }
}

async function captureState(page: Page): Promise<PageState> {
  const dialogCount = await page
    .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
    .count()
    .catch(() => 0);
  const bodyLength = await page
    .evaluate(() => (document.body?.innerText ?? '').length)
    .catch(() => 0);
  return { url: page.url(), dialogCount, bodyLength };
}

async function classifyKind(el: Locator): Promise<ActionInventoryEntry['kind']> {
  const role = await el.getAttribute('role').catch(() => null);
  if (role === 'menuitem') return 'menu-item';
  if (role === 'tab') return 'tab';

  const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
  // A link or a custom non-semantic clickable div/span ([onclick]/[tabindex="0"]) isn't a
  // "button" in any real sense — label it honestly rather than lump it in with real buttons.
  if (tag === 'a') return 'other';

  const hasText = ((await el.textContent().catch(() => '')) ?? '').trim().length > 0;
  const hasIcon = (await el.locator('i, svg').count().catch(() => 0)) > 0;
  if (!hasText && hasIcon) return 'icon-button';
  if (tag !== 'button' && role !== 'button') return 'other';
  return 'button';
}

/** Scan and click through every distinct action element on the CURRENT page only. */
async function scanCurrentPage(
  page: Page,
  ctx: ExecutorContext,
  pageIndex: number,
): Promise<PageScanResult> {
  const startUrl = page.url();
  let totalFound = await page.locator(CANDIDATE_SELECTOR).count().catch(() => 0);

  ctx.onLog(
    `[ActionInventory] Found ${totalFound} candidate action element(s) on ${startUrl} — testing up to ${MAX_CANDIDATES_PER_PAGE}`,
  );

  const entries: ActionInventoryEntry[] = [];
  const noEffectLabels: string[] = [];
  // Dedup key, not a position — after a click causes navigation/modal/DOM changes, element
  // *indices* into CANDIDATE_SELECTOR routinely no longer refer to the same elements (widgets
  // reorder, async content loads differently on return). Re-scanning by label each round and
  // skipping already-tested labels survives that drift; a fixed-index loop silently lost most
  // candidates once the first state-changing click occurred.
  const testedKeys = new Set<string>();
  let tested = 0;
  let skippedRisky = 0;
  let staleRounds = 0;

  while (tested + skippedRisky < MAX_CANDIDATES_PER_PAGE && staleRounds < 3) {
    const candidates = page.locator(CANDIDATE_SELECTOR);
    const count = await candidates.count().catch(() => 0);
    totalFound = Math.max(totalFound, count);

    let picked = -1;
    let label = '';
    let kind: ActionInventoryEntry['kind'] = 'other';

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const candidateLabel = await describeElement(candidate, i);
      const candidateKind = await classifyKind(candidate);
      const key = `${candidateKind}:${candidateLabel}`;
      if (testedKeys.has(key)) continue;
      picked = i;
      label = candidateLabel;
      kind = candidateKind;
      break;
    }

    if (picked === -1) {
      // Nothing new visible this round — async content (widgets, sidebar) can still be
      // rendering, especially right after a recovery navigation, so wait before re-scanning
      // rather than concluding immediately. Without this wait, two stale rounds can both
      // happen within milliseconds of each other, giving the page no real chance to finish
      // rendering before the loop gives up on it.
      staleRounds++;
      await page.waitForTimeout(800);
      continue;
    }
    staleRounds = 0;
    testedKeys.add(`${kind}:${label}`);

    const el = candidates.nth(picked);

    if (isRiskyActionLabel(label)) {
      entries.push({ label, kind, pageUrl: page.url(), result: 'skipped-risky' });
      skippedRisky++;
      continue;
    }

    // A disabled element (e.g. a "Continue" button gated on an unfilled required field) will
    // never become clickable — attempting the click just wastes the full click timeout
    // waiting for actionability that's never coming, then gets misreported as "threw an
    // error" as if the element were live and something crashed. It's an expected, inert
    // state, not a defect — skip the click entirely and record it as such.
    if (!(await el.isEnabled().catch(() => true))) {
      entries.push({ label, kind, pageUrl: page.url(), result: 'skipped-disabled' });
      continue;
    }

    const before = await captureState(page);
    let result: ActionInventoryResult;
    let detail: string | undefined;
    let evidence: string | undefined;

    try {
      await el.click({ timeout: 4000 });
      await page.waitForTimeout(500);
      const after = await captureState(page);

      if (after.url !== before.url) {
        result = 'navigation';
        detail = `→ ${after.url}`;
        // Return to the starting page so remaining candidates are tested from a known state.
        // The dashboard's widgets/sidebar render asynchronously after domcontentloaded, so
        // give it real time to settle rather than a token wait — the next round's scan will
        // otherwise see a half-rendered page and wrongly conclude nothing else is testable.
        await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1200);
      } else if (after.dialogCount > before.dialogCount) {
        result = 'modal';
        await page.keyboard.press('Escape').catch(() => {});
        const closeBtn = page
          .locator('button:has-text("Cancel"), button:has-text("Close"), [aria-label*="close" i]')
          .first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click().catch(() => {});
        }
        await page.waitForTimeout(300);
      } else if (Math.abs(after.bodyLength - before.bodyLength) > 20) {
        result = 'dom-change';
      } else {
        result = 'no-effect';
        noEffectLabels.push(label);
        evidence = await shot(page, ctx, `p${pageIndex}-no-effect-${tested}`);
      }
    } catch (err) {
      result = 'error';
      detail = summarizeClickError((err as Error).message);
      evidence = await shot(page, ctx, `p${pageIndex}-error-${tested}`);
    }

    entries.push({ label, kind, pageUrl: before.url, result, detail, evidence });
    tested++;

    if (result === 'error') {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-ActionInventory',
        title: `Clicking "${label}" threw an error`,
        steps: [`Open ${before.url}`, `Click "${label}" (${kind})`],
        expected: 'Clicking a rendered, enabled action element should not throw',
        actual: detail ?? 'Unknown error',
        evidence: evidence ? [evidence] : [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: before.url,
        targetSelector: (await elementFingerprint(el)) ?? undefined,
      });
    }
  }

  return { entries, noEffectLabels, tested, skippedRisky, totalFound };
}

/** Collect a few same-origin nav-like link URLs not yet visited, to extend the inventory
 * beyond the landing page when session depth allows. Prefers nav/sidebar links over random
 * content links, since those are the app's real navigable sections. */
async function collectMorePageUrls(
  page: Page,
  visited: Set<string>,
  max: number,
): Promise<string[]> {
  const origin = new URL(page.url()).origin;
  const hrefs = await page
    .locator('nav a[href], [role="navigation"] a[href], [class*="sidebar"] a[href], [class*="side-nav"] a[href]')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))
    .catch(() => [] as string[]);

  const unique: string[] = [];
  for (const href of hrefs) {
    try {
      const u = new URL(href);
      if (u.origin !== origin || u.hash) continue;
      if (visited.has(u.href) || unique.includes(u.href)) continue;
      unique.push(u.href);
      if (unique.length >= max) break;
    } catch {
      /* ignore invalid href */
    }
  }
  return unique;
}

export async function runActionInventory(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const landingUrl = page.url();
  // How many pages to inventory, scaled by session depth — a smoke run samples just the
  // landing page, a deep run sweeps several of the app's real navigable sections.
  const maxPages = explorationBreadth(ctx, { smoke: 1, standard: 2, deep: 4, chaos: 1 });

  const allEntries: ActionInventoryEntry[] = [];
  const allNoEffectLabels: string[] = [];
  let totalFound = 0;
  let totalTested = 0;
  let totalSkippedRisky = 0;
  const visited = new Set<string>([landingUrl]);

  const first = await scanCurrentPage(page, ctx, 0);
  allEntries.push(...first.entries);
  allNoEffectLabels.push(...first.noEffectLabels);
  totalFound += first.totalFound;
  totalTested += first.tested;
  totalSkippedRisky += first.skippedRisky;

  if (maxPages > 1) {
    const morePages = await collectMorePageUrls(page, visited, maxPages - 1);
    for (let i = 0; i < morePages.length; i++) {
      const url = morePages[i];
      visited.add(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {
        ctx.onLog(`[ActionInventory] Could not load ${url} — skipping`);
        continue;
      }
      await page.waitForTimeout(800);
      const result = await scanCurrentPage(page, ctx, i + 1);
      allEntries.push(...result.entries);
      allNoEffectLabels.push(...result.noEffectLabels);
      totalFound += result.totalFound;
      totalTested += result.tested;
      totalSkippedRisky += result.skippedRisky;
    }
    // Return to the landing page so the next task in the session starts from a known state.
    await page.goto(landingUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  const byResult: Record<string, number> = {};
  for (const e of allEntries) byResult[e.result] = (byResult[e.result] ?? 0) + 1;

  ctx.actionInventory = {
    totalFound,
    totalTested,
    totalSkippedRisky,
    byResult,
    entries: allEntries,
  };

  if (allNoEffectLabels.length > 0) {
    // Each no-effect click already captured its own screenshot at the moment it happened
    // (scanCurrentPage above) — this aggregate finding previously reported the labels but
    // never surfaced any of those screenshots, leaving "no visible change" unverifiable
    // without re-running the check yourself.
    const noEffectEvidence = allEntries
      .filter((e): e is ActionInventoryEntry & { evidence: string } => e.result === 'no-effect' && !!e.evidence)
      .map((e) => e.evidence)
      .slice(0, 5);
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ActionInventory',
      title: `${allNoEffectLabels.length} action element(s) produced no visible effect when clicked`,
      steps: [`Open ${landingUrl} (and other pages visited — see evidence)`, 'Click each listed element'],
      expected: 'Every rendered, enabled action element should produce a visible effect (navigation, modal, or content change) or be disabled if inactive',
      actual: `No visible change after clicking: ${allNoEffectLabels.slice(0, 15).join(', ')}${allNoEffectLabels.length > 15 ? `, and ${allNoEffectLabels.length - 15} more` : ''}`,
      evidence: noEffectEvidence,
      reproRate: '1/1',
      automationCandidate: true,
    });
  }

  ctx.onFinding({
    severity: 'info',
    area: 'UI-ActionInventory',
    title: `Action inventory: ${totalFound} action element(s) found across ${visited.size} page(s), ${totalTested} tested, ${byResult['no-effect'] ?? 0} produced no effect`,
    steps: [`Scan ${landingUrl} and up to ${maxPages - 1} more navigable page(s) for buttons/icon-buttons/menu items/tabs`, 'Click each non-destructive one'],
    expected: 'Coverage summary — not itself a bug',
    actual:
      `Found ${totalFound} candidates across ${visited.size} page(s) (tested ${totalTested}, skipped ${totalSkippedRisky} as risky). ` +
      Object.entries(byResult)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', '),
    evidence: [],
    reproRate: 'N/A',
    automationCandidate: false,
  });

  ctx.onLog(
    `[ActionInventory] Done — ${visited.size} page(s), found ${totalFound}, tested ${totalTested}, skipped ${totalSkippedRisky} risky, ` +
      Object.entries(byResult)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
}
