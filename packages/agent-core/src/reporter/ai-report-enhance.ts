import type { Finding, HealthScore } from '@qa/shared';
import { callLLM, hasAnyLLMKey } from '@qa/shared';
import type { SeverityCounts } from './generate-report.js';

// Same discipline as classify-site-ai.ts: the deterministic path (token-overlap dedup,
// templated executive summary) always runs first and is the guaranteed result. Both
// functions here are a strict upgrade attempt on top of that, never a replacement path a
// session depends on — no configured LLM key, a timeout, a malformed response, or anything
// else going wrong all fall back to exactly what generate-report.ts already produced.

// visual-review.ts documented real observed latency for Gemini specifically at 15-35s+ under
// normal conditions (it "thinks" before responding) — my original 15s here was too tight and
// was aborting calls that would likely have succeeded, confirmed live: a plain call took
// 25s+ just to return an error. Kept at 50s as the safe default across all supported providers.
const REQUEST_TIMEOUT_MS = 50000;

/**
 * A second dedup pass on top of the deterministic token-overlap one — catches SEMANTIC
 * duplicates that don't share enough literal text to trip that heuristic (e.g. "Cannot read
 * properties of null (reading 'map')" and "...of undefined (reading 'map')" — almost
 * certainly the same underlying bug, ~0% token overlap on the word that differs). Returns
 * null (meaning: keep the deterministic result as-is) on any failure — never throws, never
 * required.
 */
export async function dedupeFindingsWithAI(findings: Finding[]): Promise<Finding[] | null> {
  if (!hasAnyLLMKey() || findings.length < 2 || findings.length > 60) return null; // skip on very large sets — not worth the token cost/latency for a report this size

  const indexed = findings.map((f, i) => `${i}: [${f.area}] ${f.title}`).join('\n');
  const prompt = `You are reviewing a QA finding list for duplicates that describe the SAME underlying bug but weren't caught by exact-text matching — e.g. "Cannot read properties of null (reading 'map')" and "Cannot read properties of undefined (reading 'map')" on the same page are almost certainly one bug, not two. Be conservative: only group findings you're genuinely confident are the same root cause, not just the same general category (two different disabled-button findings on different buttons are NOT the same bug).

FINDINGS (index: [area] title):
${indexed}

Respond with ONLY a JSON array of groups, each group a list of indices that are duplicates of each other (only include groups with 2+ indices — omit findings that have no duplicate). Example: [[2,5],[7,9,11]]. If there are no duplicates, respond with exactly: []`;

  const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
  if (!text) return null;

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  let groups: number[][];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    groups = parsed.filter(
      (g): g is number[] =>
        Array.isArray(g) && g.length >= 2 && g.every((i) => Number.isInteger(i) && i >= 0 && i < findings.length),
    );
  } catch {
    return null;
  }
  if (groups.length === 0) return null;

  const mergedAway = new Set<number>();
  const result = [...findings];
  for (const group of groups) {
    const [surviving, ...rest] = group;
    if (mergedAway.has(surviving)) continue; // already absorbed into an earlier group this pass
    const altTitles = rest.filter((i) => !mergedAway.has(i)).map((i) => findings[i].title);
    if (altTitles.length === 0) continue;
    result[surviving] = {
      ...result[surviving],
      actual: `${result[surviving].actual}\n\n(AI-grouped as the same underlying issue as: ${altTitles.join('; ')})`,
    };
    for (const i of rest) mergedAway.add(i);
  }

  return result.filter((_, i) => !mergedAway.has(i));
}

/**
 * A sharper, more specific executive summary than the fixed template can produce — same
 * fallback discipline as above. Deliberately constrained to 2-3 sentences and told to name
 * the single most important finding by title, rather than just restating the severity
 * counts the template already covers well on its own.
 */
export async function summarizeWithAI(
  findings: Finding[],
  counts: SeverityCounts,
  health: HealthScore,
  siteType: string | undefined,
  targetUrl: string,
): Promise<string | null> {
  if (!hasAnyLLMKey()) return null;

  const top = findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 8)
    .map((f) => `- [${f.severity}/${f.area}] ${f.title}`)
    .join('\n');

  const prompt = `Write a 2-3 sentence executive summary for a QA exploratory-testing report, for someone deciding whether this build is safe to ship. Be specific and concrete — name the single most important issue by what it actually is, not just its severity label. Do not use markdown formatting, headers, or bullet points — plain prose only.

Target: ${targetUrl}
Site type: ${siteType ?? 'unclassified'}
Health score: ${health.grade} (${health.score}/100)
Findings: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low
${top ? `\nTop critical/high findings:\n${top}` : '\nNo critical or high-severity findings this run.'}

Respond with ONLY the summary text, nothing else.`;

  const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
  if (!text) return null;
  const cleaned = text.trim();
  // Sanity bounds — a wildly short or long response is more likely a malformed/refused
  // answer than a genuinely useful summary; fall back to the template rather than ship it.
  if (cleaned.length < 40 || cleaned.length > 800) return null;
  return cleaned;
}

export interface FindingValidation {
  plausible: boolean;
  note: string;
}

/**
 * §30 — a Validator pass, distinct from each flow's own Detector role (noticing something)
 * and from the dedup pass above (which only asks "is this the same as another finding", never
 * "is this real at all"). Only reviews 'heuristic'-confidence findings — 'verified' findings
 * are already backed by an objective signal (HTTP status, thrown exception, direct DOM
 * measurement) and don't need a second opinion. Never drops or downgrades a finding on its
 * own say-so — an LLM flagging something "implausible" is itself just another heuristic
 * signal, not ground truth. The report keeps every finding and only adds a caveat, same
 * "potential issue — human verification recommended" discipline visual-review.ts already uses
 * for its own Gemini-sourced findings.
 */
export async function validateFindingsWithAI(findings: Finding[]): Promise<Map<number, FindingValidation> | null> {
  const candidates = findings.map((f, i) => ({ f, i })).filter(({ f }) => f.confidence === 'heuristic');
  if (!hasAnyLLMKey() || candidates.length === 0 || candidates.length > 40) return null;

  const indexed = candidates
    .map(({ f, i }) => `${i}: [${f.severity}/${f.area}] ${f.title}\n   Expected: ${f.expected}\n   Actual: ${f.actual}`.slice(0, 400))
    .join('\n');

  const prompt = `You are a senior QA engineer doing a second-pass sanity check on automated exploratory-testing findings before they reach a human reviewer. Each finding below was already flagged "heuristic confidence" by the tool that found it — some ambiguity is already expected and acknowledged. Only flag a finding as implausible when you're genuinely confident it does NOT describe a real defect on its face (e.g. the Expected/Actual actually describe normal, correct behavior; the finding is self-contradictory; or it's an obvious environment artifact) — do not flag something merely because it's uncertain; uncertainty is already priced in.

FINDINGS (index: [severity/area] title, expected, actual):
${indexed}

Respond with ONLY a JSON array of {"index": <number>, "plausible": true|false, "note": "<one short sentence why>"} — one entry for EVERY finding listed above.`;

  const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
  if (!text) return null;
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    const result = new Map<number, FindingValidation>();
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.index === 'number' &&
        Number.isInteger(entry.index) &&
        entry.index >= 0 &&
        entry.index < findings.length &&
        typeof entry.plausible === 'boolean'
      ) {
        result.set(entry.index, {
          plausible: entry.plausible,
          note: typeof entry.note === 'string' ? entry.note.slice(0, 200) : '',
        });
      }
    }
    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}
