import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { AiReview, Finding, HealthScore, LLMPart } from '@qa/shared';
import { callLLM, callLLMParts, hasAnyLLMKey, isExecutionError } from '@qa/shared';
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

  const pathOf = (u?: string) => {
    try {
      return u ? new URL(u).pathname : '';
    } catch {
      return '';
    }
  };
  const indexed = findings
    .map((f, i) => `${i}: [${f.area}] ${f.title}${f.pageUrl ? ` (page ${pathOf(f.pageUrl)})` : ''}`)
    .join('\n');
  // Hard limits on what the AI may merge, whatever it answers: same check area, and for
  // per-page errors the same page — a login-page error and a dashboard error are two bugs even
  // when the messages look alike (real case: "has_app of null" on /login was folded into a
  // "map of undefined" on /payment-dropoffs). Never merge a bug into an info note or vice versa.
  const compatible = (a: Finding, b: Finding) =>
    a.area === b.area &&
    (a.severity === 'info') === (b.severity === 'info') &&
    (!a.pageUrl || !b.pageUrl || pathOf(a.pageUrl) === pathOf(b.pageUrl));
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
    const mergeable = rest.filter((i) => !mergedAway.has(i) && compatible(findings[surviving], findings[i]));
    const altTitles = mergeable.map((i) => findings[i].title);
    if (altTitles.length === 0) continue;
    result[surviving] = {
      ...result[surviving],
      actual: `${result[surviving].actual}\n\n(AI-grouped as the same underlying issue as: ${altTitles.join('; ')})`,
    };
    for (const i of mergeable) mergedAway.add(i);
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

// ── AI review of every reported bug ────────────────────────────────────────────────────────
// The point of configuring an API key is a second, independent look at each bug before anyone
// raises it. Every defect-type finding (not info notes, not the agent's own execution issues)
// is sent with its description, steps and first screenshot; the reviewer answers agrees /
// doubts / unsure with one sentence. The answer is shown BESIDE the evidence-based badge — it
// never changes severity, confidence or the health score, and never hides a finding. Reviews
// are cached on the session by finding id, so re-opening the report doesn't pay for them again.

const REVIEW_MAX = Math.max(0, Number(process.env.AI_REVIEW_MAX_FINDINGS ?? 40));
const REVIEW_CONCURRENCY = 3;
const REVIEW_TIMEOUT_MS = 60000;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const inFlight = new Map<string, Promise<AiReview | null>>();

function firstScreenshot(f: Finding): { mimeType: string; base64: string } | null {
  for (const path of f.evidence ?? []) {
    const mime = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mime || !existsSync(path)) continue;
    try {
      if (statSync(path).size > MAX_SCREENSHOT_BYTES) continue;
      return { mimeType: mime, base64: readFileSync(path).toString('base64') };
    } catch {
      /* unreadable — try the next one */
    }
  }
  return null;
}

function reviewPrompt(f: Finding, targetUrl: string, hasImage: boolean): string {
  // First version of this prompt listed example excuses ("timing, test data, a deliberate design
  // choice") and the model repeated them back as reasons to doubt real bugs — on SauceDemo's
  // problem_user it doubted 3 of 11 findings, all 3 genuine defects. The rules below make
  // "doubts" require a concrete contradiction, and treat a direct measurement as strong evidence.
  const measured = f.confidence === 'verified';
  return `You are a senior QA engineer double-checking one bug that an automated testing agent reported on ${targetUrl}. Your job is to check the EVIDENCE, not to think of reasons the bug might not matter.

Report:
- Severity: ${f.severity}
- Check area: ${f.area}
- Title: ${f.title}
- Page: ${f.pageUrl ?? targetUrl}
- Steps the agent took:
${f.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
- Expected: ${f.expected}
- Actual (what the agent observed): ${f.actual}
- How the agent knows: ${f.confidenceReason ?? (f.confidence ?? 'not stated')}
${measured ? '- The agent MEASURED this directly in the browser (a value read before/after, a status code, a DOM attribute). Treat the "Actual" as an observed fact.\n' : ''}${hasImage ? '- The attached image is a screenshot the agent took. It may be from before or after the action, so a screenshot that does not show the problem is NOT evidence against it.\n' : '- No screenshot is available.\n'}
Rules:
1. "agrees" — the observed Actual differs from the Expected in a way a user, the business or an accessibility/security standard would care about. Most objectively measured differences are real bugs, even on demo sites.
2. "doubts" — ONLY when something in the report or screenshot concretely contradicts the claim (e.g. the screenshot clearly shows the value the agent says is missing, or the Expected itself is wrong). Name that contradiction in the reason.
3. "unsure" — the evidence is too thin to tell either way. Possible explanations you merely imagine (timing, design intent, test data) are not evidence: if that is all you have, answer "agrees" for a measured result, otherwise "unsure".

Reply with ONLY a JSON object, no markdown:
{"verdict": "agrees" | "doubts" | "unsure", "reason": "<one plain-English sentence a non-technical reader understands, pointing at the evidence>"}`;
}

async function reviewOne(f: Finding, targetUrl: string): Promise<AiReview | null> {
  const image = firstScreenshot(f);
  const parts: LLMPart[] = [{ type: 'text', text: reviewPrompt(f, targetUrl, !!image) }];
  if (image) parts.push({ type: 'image', mimeType: image.mimeType, base64: image.base64 });
  const text = await callLLMParts(parts, REVIEW_TIMEOUT_MS, { strong: true });
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    const verdict = parsed.verdict === 'agrees' || parsed.verdict === 'doubts' || parsed.verdict === 'unsure' ? parsed.verdict : null;
    const reason = (parsed.reason ?? '').trim().slice(0, 400);
    if (!verdict || reason.length < 5) return null;
    return { verdict, reason };
  } catch {
    return null;
  }
}

/**
 * Reviews every not-yet-reviewed defect-type finding (up to AI_REVIEW_MAX_FINDINGS, default 40)
 * and returns the cache with the new reviews added. Unchanged (and no calls made) when no LLM
 * key is configured.
 */
export async function reviewFindingsWithAI(
  findings: Finding[],
  cache: Record<string, AiReview>,
  targetUrl: string,
): Promise<Record<string, AiReview>> {
  if (!hasAnyLLMKey() || REVIEW_MAX === 0) return cache;
  const todo = findings
    .filter((f) => f.severity !== 'info' && !isExecutionError(f) && !cache[f.id])
    .slice(0, REVIEW_MAX);
  if (todo.length === 0) return cache;

  const result = { ...cache };
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      let pending = inFlight.get(f.id);
      if (!pending) {
        pending = reviewOne(f, targetUrl).catch(() => null);
        inFlight.set(f.id, pending);
      }
      const review = await pending;
      inFlight.delete(f.id);
      if (review) result[f.id] = review;
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, todo.length) }, worker));
  return result;
}
