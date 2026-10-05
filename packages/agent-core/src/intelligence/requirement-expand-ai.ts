// Requirement-aware exploration: given a short free-text requirement/feature description
// (config.context — e.g. "User can partially pay an invoice"), produce SPECIFIC, concrete
// boundary-condition instructions to test around it — the exact pattern from the "exploratory
// agent" design doc: infer the feature's important states (unpaid/partially paid/fully paid),
// then explore 0-value, exact-boundary, over-boundary, cancel-mid-flow, refresh, duplicate-
// submit, and logout/login-persistence variants of it. Deliberately does NOT attempt to parse
// a PDF/file — that whole subsystem (prd-parser) was removed from this codebase; this only
// ever consumes the free text already in config.context, expanding it into something the
// existing `user-directed` executor (which already knows how to follow a freeform instruction
// and gate risky ones) can actually act on.
//
// Same discipline as classify-site-ai.ts: this is a strict upgrade attempt over the
// deterministic fallback (naive sentence-splitting in planner/index.ts), never required. No
// configured LLM key, a timeout, or a malformed response all fall back to that existing
// behavior unchanged.
import { callLLM, hasAnyLLMKey } from '@qa/shared';

// Matches the timeout this codebase has already had to correct once (ai-report-enhance.ts) —
// Gemini in particular has documented real-world latency of 15-35s+, not the ~15s a first
// guess might reach for; kept at 50s as the safe default across all supported providers.
const REQUEST_TIMEOUT_MS = 50000;
const MAX_INSTRUCTIONS = 8;

export async function expandRequirementWithAI(context: string): Promise<string[] | null> {
  if (!hasAnyLLMKey() || context.trim().length < 10) return null;

  const prompt = `You are a QA engineer turning a short feature description into a list of SPECIFIC, concrete exploratory test instructions — boundary values, interruptions, and state-persistence checks a human tester would think to try, not a restatement of the feature itself.

FEATURE DESCRIPTION:
"${context.slice(0, 1000)}"

First identify the feature's important states (e.g. for "partially pay an invoice": unpaid, partially paid, fully paid). Then write specific test instructions covering boundary values (zero, exact boundary, over the boundary), interruption (cancel mid-flow, refresh, browser back), duplicate/rapid submission, and state persistence across logout/login — but ONLY the ones that genuinely make sense for this specific feature, not a generic checklist applied blindly.

Respond with ONLY a JSON array of instruction strings, each one a single concrete, actionable sentence a browser-automation agent could follow (e.g. "Enter 0 as the payment amount and attempt to submit"). Maximum ${MAX_INSTRUCTIONS} instructions. If the description is too vague to derive anything specific, respond with exactly: []`;

  try {
    const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
    if (!text) return null;

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    const instructions = parsed
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 10 && s.trim().length < 300)
      .slice(0, MAX_INSTRUCTIONS);

    return instructions.length > 0 ? instructions : null;
  } catch {
    return null;
  }
}
