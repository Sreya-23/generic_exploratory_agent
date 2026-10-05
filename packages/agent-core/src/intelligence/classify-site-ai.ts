import type { SiteClassification, SiteIntelligenceSignals, SiteType } from '@qa/shared';
import { callLLM, hasAnyLLMKey } from '@qa/shared';

// Optional, higher-context replacement for the hardcoded keyword-scored RULES in
// classify-site.ts. That rule set can only ever recognize the handful of site types someone
// thought to write a rule for, and scores them by fixed keyword lists — it has no way to
// reason about what a genuinely unusual or hybrid site is actually FOR. This sends the same
// recon signals to the configured LLM (Gemini/OpenAI/Anthropic — see llm-client.ts) and asks
// for real contextual judgment instead of keyword counting.
//
// Deliberately additive, never load-bearing: this is one call per SESSION (not per task,
// unlike visual-review.ts), fired once right after recon. If no LLM key is configured, the
// call fails for any reason, or the model's response doesn't parse into a valid
// classification, this returns null and the caller falls back to the deterministic
// classifySite() rule set — which keeps running unconditionally either way, so a bad AI-
// provider day never leaves a session unclassified.

// Text-only, no image — should resolve in a couple of seconds. Bounded well below the 50s
// default so a hung request can't stall the one-time recon task the rest of the plan depends on.
const REQUEST_TIMEOUT_MS = 15000;

const KNOWN_SITE_TYPES: SiteType[] = [
  'ecommerce',
  'booking',
  'saas-dashboard',
  'auth-portal',
  'blog-cms',
  'social',
  'fintech',
  'ai-product',
  'generic',
];

interface RawClassification {
  siteType?: string;
  confidence?: number;
  signals?: string[];
  inferredJourneys?: string[];
  keyFeatures?: string[];
}

function buildPrompt(s: SiteIntelligenceSignals): string {
  return `You are a senior QA engineer looking at signals scraped from a web page you are about to exploratory-test. Classify what KIND of application this is, and infer the specific user journeys worth testing on THIS particular site — not generic placeholders.

PAGE SIGNALS:
- Title: ${s.title || '(none)'}
- Meta description: ${s.metaDescription || '(none)'}
- Headings: ${s.headings.slice(0, 15).join(' | ') || '(none)'}
- Link texts: ${s.linkTexts.slice(0, 30).join(' | ') || '(none)'}
- Button texts: ${s.buttonTexts.slice(0, 30).join(' | ') || '(none)'}
- Input field types present: ${s.inputTypes.join(', ') || '(none)'}
- URL paths seen: ${s.urlPaths.slice(0, 20).join(', ') || '(none)'}
- Visible text sample: ${s.textSample.slice(0, 1500) || '(none)'}

Respond with ONLY a JSON object (no markdown fences, no commentary), shaped exactly as:
{
  "siteType": one of ${JSON.stringify(KNOWN_SITE_TYPES)},
  "confidence": a number from 0 to 1 for how sure you are,
  "signals": ["short evidence phrase 1", "short evidence phrase 2", ...] (2-5 items, ground this in what you actually saw above),
  "inferredJourneys": ["a specific, concrete, testable user journey on THIS site", ...] (3-6 items — be specific to what this page actually offers, not a generic template for the category),
  "keyFeatures": ["short-token feature 1", ...] (2-6 items)
}

If nothing above gives you real signal, use "siteType": "generic" with a low confidence rather than guessing.`;
}

function extractJsonObject(text: string): RawClassification | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as RawClassification) : null;
  } catch {
    return null;
  }
}

function toStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max);
}

/**
 * Returns an AI-derived SiteClassification, or null if no provider key is configured, the
 * call fails, or the response can't be validated into a real classification — in every "null"
 * case the caller is expected to fall back to the deterministic classifySite() rule set.
 */
export async function classifySiteWithAI(
  signals: SiteIntelligenceSignals,
): Promise<SiteClassification | null> {
  if (!hasAnyLLMKey()) return null;

  try {
    const text = await callLLM(buildPrompt(signals), REQUEST_TIMEOUT_MS);
    if (!text) return null;
    const raw = extractJsonObject(text);
    if (!raw || typeof raw.siteType !== 'string') return null;

    // Never trust the model's siteType blindly — everything downstream (journey dispatch,
    // flow selection) is keyed by the fixed SiteType union, so an unrecognized value must
    // fall back to the rule-based result rather than silently becoming an untyped string.
    if (!KNOWN_SITE_TYPES.includes(raw.siteType as SiteType)) return null;

    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5;

    const inferredJourneys = toStringArray(raw.inferredJourneys, 6);
    if (inferredJourneys.length === 0) return null; // no real signal worth acting on

    return {
      siteType: raw.siteType as SiteType,
      confidence,
      signals: toStringArray(raw.signals, 5),
      inferredJourneys,
      keyFeatures: toStringArray(raw.keyFeatures, 6),
    };
  } catch {
    // Network failure, timeout, malformed JSON — any of these fall back to the rule-based
    // classifier, never block or fail the recon task itself.
    return null;
  }
}
