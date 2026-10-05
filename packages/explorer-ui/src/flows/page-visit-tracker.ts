import type { Page } from 'playwright';

// Same reasoning as js-error-tracker.ts: every task gets a fresh page/context, so this
// module-level, session-keyed store is what lets "which pages did we actually visit" survive
// across the whole session instead of resetting every task.
const sessionVisits = new Map<string, Set<string>>();
// Path alone answers "did we ever reach this ROUTE" (what coverage-report.ts needs). It
// deliberately does NOT answer "have we already explored /users with search=John and
// filter=active, or is this a genuinely new state" — a session-wide version of the same gap
// navigation.ts's own BFS already solves locally via visitedUrls/visitedTabStates, but nothing
// exposed across tasks. Tracked separately (not by widening the existing set) so
// coverage-report.ts's route-level ratio keeps working unchanged.
const sessionStates = new Map<string, Set<string>>();

function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return null; // about:blank, data:, etc.
  }
}

function normalizeState(url: string): string | null {
  try {
    const u = new URL(url);
    // Sort query params so ?a=1&b=2 and ?b=2&a=1 count as the same state, not two different
    // ones — the same normalization discipline already applied to route comparison elsewhere.
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const search = params.length > 0 ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return u.origin + u.pathname + search;
  } catch {
    return null;
  }
}

/** Call once per newly-created page so every main-frame navigation it makes is recorded. */
export function attachVisitTracking(page: Page, sessionId: string): void {
  if (!sessionVisits.has(sessionId)) sessionVisits.set(sessionId, new Set());
  if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, new Set());
  const pathStore = sessionVisits.get(sessionId)!;
  const stateStore = sessionStates.get(sessionId)!;

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const normalized = normalize(url);
    if (normalized) pathStore.add(normalized);
    const state = normalizeState(url);
    if (state) stateStore.add(state);
  });
}

export function getVisitedPaths(sessionId: string): string[] {
  return [...(sessionVisits.get(sessionId) ?? [])];
}

/** Every distinct (route + sorted query params) combination visited this session — the
 *  session-wide "have we already explored this exact state" answer, finer-grained than
 *  getVisitedPaths(). */
export function getVisitedStates(sessionId: string): string[] {
  return [...(sessionStates.get(sessionId) ?? [])];
}

export function clearVisitTracking(sessionId: string): void {
  sessionVisits.delete(sessionId);
  sessionStates.delete(sessionId);
}
