/**
 * Self-healing element matching: score every visible candidate against several independent
 * signals (text, aria-label, icon class, role) instead of trying a fixed selector priority
 * list and stopping at the first thing that matches anything. A single ordered list breaks
 * whenever a site's markup doesn't match the first alternative that happens to exist
 * elsewhere on the page (exactly the class of bug fixed by hand, repeatedly, elsewhere in
 * this codebase this session — hidden dialog placeholders, icon-only buttons, ARIA header
 * rows). Scoring survives those cases because it considers *all* signals together instead of
 * betting everything on selector order.
 *
 * Also maintains a persistent per-origin cache: once a real match is found for a given
 * intent on a given site, remember its descriptor so a later run tries that exact match
 * first, skipping the full scoring scan when the site hasn't changed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';

export interface MatchIntent {
  /** Cache key — must be stable and unique per distinct thing you're looking for. */
  id: string;
  /** Broad candidate selector(s) to score across — cast wide, let scoring narrow it down. */
  candidateSelector: string;
  /** Case-insensitive keywords that should appear in the element's visible text. */
  textKeywords?: string[];
  /** Keywords that should appear in aria-label/title. */
  ariaKeywords?: string[];
  /** Keywords that should appear in a contained <i>/<svg> icon's class attribute. */
  iconKeywords?: string[];
  /** ARIA roles that should score this element up. */
  roles?: string[];
  /** Keywords whose presence should score an element DOWN (e.g. avoid a decoy trigger). */
  negativeKeywords?: string[];
}

interface ScoredCandidate {
  locator: Locator;
  score: number;
  descriptor: string;
}

const CACHE_FILE = 'selector-cache.json';

type SelectorCache = Record<string, string>; // `${origin}|${intentId}` -> descriptor (label text)

function loadCache(sessionsDir: string): SelectorCache {
  try {
    const path = join(sessionsDir, CACHE_FILE);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf-8')) as SelectorCache;
  } catch {
    return {};
  }
}

function saveCache(sessionsDir: string, cache: SelectorCache): void {
  try {
    writeFileSync(join(sessionsDir, CACHE_FILE), JSON.stringify(cache, null, 2));
  } catch {
    /* best-effort — a missing cache just means no fast-path next time */
  }
}

function cacheKey(origin: string, intentId: string): string {
  return `${origin}|${intentId}`;
}

async function scoreCandidate(el: Locator, intent: MatchIntent): Promise<number> {
  let score = 0;
  const text = ((await el.textContent().catch(() => '')) ?? '').toLowerCase();
  const aria = (
    (await el.getAttribute('aria-label').catch(() => '')) ??
    (await el.getAttribute('title').catch(() => '')) ??
    ''
  ).toLowerCase();
  // .getAttribute() on a locator auto-waits for it to resolve to an attached element —
  // if this candidate has NO <i>/<svg> child at all (the overwhelming common case for a
  // plain text button), `.first()` matches nothing and the call blocks for Playwright's
  // full default actionability timeout (tens of seconds) before giving up, PER CANDIDATE.
  // With scoreCandidate called for every candidate on every findByIntentWithRetry poll,
  // this alone is what turned a few real element lookups into 30-90s hangs across this
  // whole codebase, on every site that reached this code path — .count() first is a plain,
  // non-waiting DOM query, so a candidate with no icon costs nothing extra to skip.
  const iconLocator = el.locator('i, svg').first();
  const iconClass = (
    (await iconLocator.count().catch(() => 0)) > 0
      ? (await iconLocator.getAttribute('class').catch(() => '')) ?? ''
      : ''
  ).toLowerCase();
  const role = ((await el.getAttribute('role').catch(() => '')) ?? '').toLowerCase();

  for (const kw of intent.textKeywords ?? []) {
    if (text.includes(kw.toLowerCase())) score += 3;
  }
  for (const kw of intent.ariaKeywords ?? []) {
    if (aria.includes(kw.toLowerCase())) score += 3;
  }
  for (const kw of intent.iconKeywords ?? []) {
    if (iconClass.includes(kw.toLowerCase())) score += 2;
  }
  for (const r of intent.roles ?? []) {
    if (role === r.toLowerCase()) score += 1;
  }
  for (const kw of intent.negativeKeywords ?? []) {
    if (text.includes(kw.toLowerCase()) || aria.includes(kw.toLowerCase())) score -= 5;
  }
  return score;
}

/**
 * Find the best-matching visible element for `intent` on the current page. Tries the cached
 * descriptor from a previous successful match on this origin first (cheap, no scoring pass);
 * falls back to scoring every candidate when there's no cache hit or the cached element is no
 * longer present.
 */
export async function findByIntent(
  page: Page,
  ctx: ExecutorContext,
  intent: MatchIntent,
  scope?: Locator,
): Promise<Locator | null> {
  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return page.url();
    }
  })();
  const cache = loadCache(ctx.sessionsDir);
  const key = cacheKey(origin, intent.id);
  const cachedDescriptor = cache[key];

  const candidates = (scope ?? page).locator(intent.candidateSelector);
  const count = await candidates.count().catch(() => 0);
  if (count === 0) return null;

  // Fast path: try the exact descriptor (visible text) that won last time on this origin.
  if (cachedDescriptor) {
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => '')) ?? '').trim();
      if (text === cachedDescriptor) return el;
    }
    // Cached descriptor no longer present — fall through to a full re-score below.
  }

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const score = await scoreCandidate(el, intent);
    if (score <= 0) continue;
    const descriptor = ((await el.textContent().catch(() => '')) ?? '').trim();
    scored.push({ locator: el, score, descriptor });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];

  if (winner.descriptor) {
    cache[key] = winner.descriptor;
    saveCache(ctx.sessionsDir, cache);
  }
  return winner.locator;
}

/**
 * `findByIntent`, but polling for up to `timeoutMs` instead of a single instant scan.
 * Client-rendered apps routinely haven't mounted the element you're looking for yet at the
 * moment a task starts — the same class of bug fixed repeatedly elsewhere in this codebase
 * this session (login fields, nav collection, journey buttons). A one-shot scan would
 * silently reintroduce it here too.
 */
export async function findByIntentWithRetry(
  page: Page,
  ctx: ExecutorContext,
  intent: MatchIntent,
  timeoutMs = 6000,
  scope?: Locator,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  let result: Locator | null = null;
  try {
    result = await findByIntent(page, ctx, intent, scope);
    while (!result && Date.now() < deadline) {
      await page.waitForTimeout(400);
      result = await findByIntent(page, ctx, intent, scope);
    }
  } catch {
    // Page/context/browser closed out from under us — e.g. the task's own timeout fired and
    // closed the context while this poll loop was still running (Promise.race doesn't cancel
    // the losing side, so this can legitimately happen mid-flow, not just in a test harness).
    // Bail cleanly instead of throwing an unhandled exception into the caller.
    return null;
  }
  return result;
}
