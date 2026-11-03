import type { Finding, Severity } from './types.js';
import { isExecutionError, isObservation } from './finding-classification.js';

// Display order for findings in reports and the report page: grouped by kind of problem, in the
// order a reader triages them — what the user sees and does (UI) first, then the backend (API),
// then JavaScript errors, then resilience/performance, and security last. Within a group,
// most severe first. Info notes (observations, not defects) come after every defect, and the
// agent's own execution issues come last. (The "top issue" in the executive summary and next steps still picks the
// single most severe finding overall — this order is for listing, not for prioritising.)

export interface FindingCategory {
  rank: number;
  label: string;
}

export const FINDING_CATEGORIES: FindingCategory[] = [
  { rank: 1, label: 'UI & interaction' },
  { rank: 2, label: 'API' },
  { rank: 3, label: 'JavaScript errors' },
  { rank: 4, label: 'Resilience & performance' },
  { rank: 5, label: 'Security' },
  { rank: 6, label: 'Agent execution' },
];

// API checks whose findings are about access control or data exposure belong with security.
const SECURITY_AREAS = /^(security-|api-auth$|api-security$|api-cors$|api-sensitivedataexposure$|ui-authorization$)/i;

export function findingCategory(area: string): FindingCategory {
  const a = (area || '').toLowerCase();
  let rank: number;
  if (a === 'ui-error' || a === 'ui-environment') rank = 6;
  else if (SECURITY_AREAS.test(a)) rank = 5;
  else if (a === 'ui-jserror') rank = 3;
  else if (a.startsWith('api-')) rank = 2;
  else if (a.startsWith('chaos-') || a.startsWith('perf') || a === 'ui-chaos' || a === 'ui-performance') rank = 4;
  else rank = 1; // UI-*, A11y-*, Regression-*, DeviceMatrix, CrossBrowser, Navigation, AI-*, …
  return FINDING_CATEGORIES.find((c) => c.rank === rank)!;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

type OrderableFinding = Pick<Finding, 'area' | 'severity' | 'title'> & Partial<Pick<Finding, 'tags' | 'quarantineReason'>>;

/**
 * Which block of the list a finding belongs to: 0 = real defects (grouped by category),
 * 1 = info notes (observations — not defects), 2 = the agent's own execution issues.
 * Every defect, down to the lowest-severity security one, is listed before any info note.
 */
export function findingDisplayTier(f: OrderableFinding): 0 | 1 | 2 {
  const asFinding = f as Finding;
  if (isExecutionError(asFinding)) return 2;
  if (isObservation(asFinding)) return 1;
  return 0;
}

/** Heading for the block a finding is listed under. */
export function findingSectionLabel(f: OrderableFinding): string {
  const tier = findingDisplayTier(f);
  if (tier === 1) return 'Info notes (not defects)';
  if (tier === 2) return 'Agent execution issues (not defects)';
  return findingCategory(f.area).label;
}

const sevRank = (s: Severity): number => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i < 0 ? SEVERITY_ORDER.length : i;
};

/**
 * THE display order, used by the web report page and every downloadable report so they always
 * match:
 *   1. block — defects, then info notes, then agent execution issues
 *   2. category — UI → API → JS errors → resilience/performance → security
 *   3. check area — findings from the same check stay together; the area holding the most
 *      severe finding comes first (ties: more findings first, then name)
 *   4. severity, then title, inside the area
 */
export function sortFindingsForDisplay<T extends OrderableFinding>(findings: T[]): T[] {
  const areaKey = (f: OrderableFinding) => `${findingDisplayTier(f)}|${f.area || 'general'}`;
  const worst = new Map<string, number>();
  const count = new Map<string, number>();
  for (const f of findings) {
    const k = areaKey(f);
    worst.set(k, Math.min(worst.get(k) ?? 99, sevRank(f.severity)));
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...findings].sort((a, b) => {
    const t = findingDisplayTier(a) - findingDisplayTier(b);
    if (t !== 0) return t;
    const c = findingCategory(a.area).rank - findingCategory(b.area).rank;
    if (c !== 0) return c;
    const ka = areaKey(a);
    const kb = areaKey(b);
    if (ka !== kb) {
      return (
        worst.get(ka)! - worst.get(kb)! ||
        count.get(kb)! - count.get(ka)! ||
        (a.area || '').localeCompare(b.area || '')
      );
    }
    return sevRank(a.severity) - sevRank(b.severity) || a.title.localeCompare(b.title);
  });
}

/**
 * Pairwise comparator (no area clustering) — prefer sortFindingsForDisplay for lists.
 * All defects first — by category (UI → API → JS errors → resilience/
 * performance → security), then severity — then info notes, then agent execution issues.
 */
export function compareFindingsForDisplay(a: OrderableFinding, b: OrderableFinding): number {
  const t = findingDisplayTier(a) - findingDisplayTier(b);
  if (t !== 0) return t;
  const c = findingCategory(a.area).rank - findingCategory(b.area).rank;
  if (c !== 0) return c;
  const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (s !== 0) return s;
  return a.title.localeCompare(b.title);
}

/**
 * Removes repeated info notes so the notes list doesn't say the same thing twice:
 *  - identical notes (same area, title and details) — e.g. two journeys both skipping checkout
 *  - a "page itself returns 404" JS-error note when a dead-links note already reports that URL
 *  - the navigation crawl's console-error summary when the JS-error check already reported them
 * Other defects are left alone (their de-duplication happens in the reporter, with evidence merging).
 */
export function collapseDuplicateNotes<T extends OrderableFinding & Partial<Pick<Finding, 'actual'>>>(findings: T[]): T[] {
  const seen = new Set<string>();
  const deadLinkText = findings
    .filter((f) => /^ui-deadlinks$/i.test(f.area) && findingDisplayTier(f) === 1)
    .map((f) => (f.actual ?? '').toLowerCase())
    .join('\n');
  // The navigation crawl also lists console errors it saw ("JavaScript console errors detected
  // during site traversal") — the same errors the dedicated JS-error check reports one by one,
  // with better classification. When that check produced anything, the crawl's summary is a repeat.
  const hasJsErrorCheck = findings.some((f) => /^ui-jserror$/i.test(f.area));
  return findings.filter((f) => {
    if (hasJsErrorCheck && /^ui-navigation$/i.test(f.area) && /console errors detected/i.test(f.title)) return false;
    if (findingDisplayTier(f) === 0) return true;
    const key = `${f.area}|${f.title}|${f.actual ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (/^ui-jserror$/i.test(f.area) && /this is the page itself/i.test(f.actual ?? '')) {
      const url = (f.actual ?? '').match(/failed URL: (\S+)/i)?.[1]?.replace(/[#?].*$/, '').toLowerCase();
      if (url && deadLinkText.includes(url)) return false;
    }
    return true;
  });
}
