import type { Page } from 'playwright';

// Same reasoning as js-error-tracker.ts: every task gets a fresh page/context, so this
// module-level, session-keyed store is what lets "which pages did we actually visit" survive
// across the whole session instead of resetting every task.
const sessionVisits = new Map<string, Set<string>>();

function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return null; // about:blank, data:, etc.
  }
}

/** Call once per newly-created page so every main-frame navigation it makes is recorded. */
export function attachVisitTracking(page: Page, sessionId: string): void {
  if (!sessionVisits.has(sessionId)) sessionVisits.set(sessionId, new Set());
  const store = sessionVisits.get(sessionId)!;

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const normalized = normalize(frame.url());
    if (normalized) store.add(normalized);
  });
}

export function getVisitedPaths(sessionId: string): string[] {
  return [...(sessionVisits.get(sessionId) ?? [])];
}

export function clearVisitTracking(sessionId: string): void {
  sessionVisits.delete(sessionId);
}
