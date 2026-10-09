/**
 * Many `Finding.actual`/`Finding.expected` strings pack a whole list into one run-on sentence
 * ("button X looks disabled but is clickable; button Y looks disabled but is clickable; ...",
 * "Missing: A, B, C", "dom-change: 8, modal: 2, navigation: 9") because the check files that
 * produce them use `.join('; ')`/`.join(', ')` to build a single string field — there's nowhere
 * else in the `Finding` shape to put a list. Rather than changing that shape (every one of the
 * ~80 check files across the codebase would need touching), this detects the already-present
 * list structure at render time and splits it back out, so the UI/report can show a bullet list
 * instead of a wall of semicolons. Pure string heuristics, no dependencies — safe to use from
 * both the browser (FindingCard.tsx) and the report generator (generate-report.ts).
 */
export interface StructuredText {
  intro: string | null;
  items: string[];
}

export function parseListLikeText(text: string): StructuredText | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Semicolon-separated clauses — the dominant separator this codebase uses for a list of
  // independently-complete facts (one full statement per item).
  if (trimmed.includes(';')) {
    const parts = trimmed.split(';').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return { intro: null, items: parts };
  }

  // 2. A run of 2+ "label: value" pairs joined by commas, anywhere in the string (a stats
  // summary like "dom-change: 8, modal: 2, navigation: 9", or "Total requests: 29, retries: yes,
  // elapsed: 4.3s") — checked before the generic colon-prefix case below so the run isn't
  // mistaken for one long "label" with a single value. The label allows up to 3 space-separated
  // words ("Total requests", "Rate-limited") and the value allows '/' for fraction-shaped
  // values ("50/50") alongside word/dot/percent characters.
  const statsRun = trimmed.match(
    /((?:[A-Za-z][\w-]*(?:\s[A-Za-z][\w-]*){0,2}:\s*[\w./%-]+)(?:,\s*[A-Za-z][\w-]*(?:\s[A-Za-z][\w-]*){0,2}:\s*[\w./%-]+)+)/,
  );
  if (statsRun && statsRun.index !== undefined) {
    const items = statsRun[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const intro = trimmed.slice(0, statsRun.index).trim();
    const rest = trimmed.slice(statsRun.index + statsRun[1].length).trim();
    if (items.length >= 2 && !rest) return { intro: intro || null, items };
  }

  // 3. "Label: item1, item2, item3" — one colon near the start (within 150 chars, so it can't
  // accidentally swallow an entire multi-sentence paragraph), then 2+ comma-separated items.
  const labeled = trimmed.match(/^(.{3,150}?):\s*(.+)$/);
  if (labeled) {
    const items = labeled[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (items.length >= 2) return { intro: `${labeled[1].trim()}:`, items };
  }

  return null;
}
