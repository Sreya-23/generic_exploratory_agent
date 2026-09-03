// A growing library of legitimate, deliberate UI states that a naive "content looks sparse /
// different from baseline" check would otherwise misreport as a defect. Each entry here is a
// real false-positive class this agent hit and got corrected on — see SKILL.md's changelog for
// the story behind each one. Centralized so every check (device-matrix, visual-review, and any
// future one) recognizes the same set consistently instead of re-inventing its own heuristic.
export interface NonBugPattern {
  id: string;
  label: string;
  pattern: RegExp;
}

export const NON_BUG_PATTERNS: NonBugPattern[] = [
  {
    id: 'app-gate',
    label: 'Mobile app download gate',
    pattern: /download.{0,30}(mobile )?app|get it on|app store|google play|play store/i,
  },
  {
    id: 'cookie-consent',
    label: 'Cookie/consent banner',
    pattern: /(we use cookies|cookie policy|accept cookies|manage cookies|cookie consent)/i,
  },
  {
    id: 'maintenance',
    label: 'Maintenance / coming-soon page',
    pattern: /(under maintenance|coming soon|we'?ll be back|scheduled maintenance|temporarily unavailable)/i,
  },
  {
    id: 'empty-state',
    label: 'Generic empty/loading state',
    pattern: /(no data (yet|available)|nothing (here|to show)|please wait|loading\.{0,3}$)/i,
  },
];

/** Label of the first matching known non-bug pattern for this text, or null if none apply. */
export function matchesKnownNonBugPattern(text: string): string | null {
  for (const p of NON_BUG_PATTERNS) {
    if (p.pattern.test(text)) return p.label;
  }
  return null;
}
