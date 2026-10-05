// Per-DOMAIN-CATEGORY knowledge base: gives the agent persistent memory of what a given KIND
// of application typically looks like, across sessions and across different sites. Keyed by
// business category (classification.siteType — fintech, ecommerce, saas-dashboard, ...), not
// by hostname: the first fintech site ever explored captures fintech.md; the next, entirely
// different fintech site reuses that same doc instead of starting from zero, because it's the
// same KIND of application. Only ever generated ONCE per category (the first time that
// category is seen) and reused silently after — never regenerated/diff-updated automatically,
// per an explicit product decision (cost/time tradeoff, and this quota is shared across
// several AI features in this codebase already — see llm-client.ts).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteClassification, SiteIntelligenceSignals, SiteType } from '@qa/shared';
import { callLLM, hasAnyLLMKey } from '@qa/shared';

// Same documented real-world latency precedent as every other AI call in this codebase
// (visual-review.ts, ai-report-enhance.ts, requirement-expand-ai.ts) — Gemini in particular
// can take 15-35s+; 50s is the safe default across all supported providers.
const REQUEST_TIMEOUT_MS = 50000;

function docPath(knowledgeBaseDir: string, siteType: SiteType): string {
  return join(knowledgeBaseDir, `${siteType}.md`);
}

/** Null when no doc exists yet for this category — a genuinely new kind of application. */
export async function loadSiteKnowledge(knowledgeBaseDir: string, siteType: SiteType): Promise<string | null> {
  const path = docPath(knowledgeBaseDir, siteType);
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function saveSiteKnowledge(knowledgeBaseDir: string, siteType: SiteType, content: string): Promise<void> {
  await mkdir(knowledgeBaseDir, { recursive: true });
  await writeFile(docPath(knowledgeBaseDir, siteType), content, 'utf-8');
}

/**
 * Gemini-based application walkthrough — synthesizes what recon/classification gathered from
 * THIS ONE example site into a structured, human-readable description of what applications in
 * THIS CATEGORY generally look like (modules, primary user, key flows, risk areas), matching
 * the shape the original architecture doc proposed for domain classification. Written to
 * generalize: explicitly told this will be reused as a reference for OTHER, different sites of
 * the same category, not just the one it was captured from. Same hybrid discipline as
 * everywhere else in this codebase: additive only, returns null on any failure (unset API key,
 * timeout, malformed response) — a missing knowledge-base doc is never load-bearing.
 */
async function generateWalkthroughDoc(
  hostname: string,
  signals: SiteIntelligenceSignals,
  classification: SiteClassification,
): Promise<string | null> {
  if (!hasAnyLLMKey()) return null;

  const prompt = `You are documenting a CATEGORY of web application for a QA team, based on one example site they just crawled. This doc will be reused as reference context for OTHER, different websites that get classified into the same category later — so describe the general pattern this category of application follows, not just trivia specific to this one example site.

Category: ${classification.siteType}
Example site crawled: ${hostname}
Page title: ${signals.title}
Meta description: ${signals.metaDescription || '(none)'}
Headings seen: ${signals.headings.slice(0, 15).join(', ') || '(none)'}
Button/link text seen: ${[...signals.buttonTexts, ...signals.linkTexts].slice(0, 30).join(', ') || '(none)'}
Input field types seen: ${signals.inputTypes.slice(0, 15).join(', ') || '(none)'}
Discovered routes: ${signals.urlPaths.slice(0, 30).join(', ') || '(none)'}
Rule/AI classification confidence: ${Math.round(classification.confidence * 100)}%, inferred journeys: ${classification.inferredJourneys.join(', ') || 'none'}

Write the doc with these sections: "## What this category of application typically is" (1-2 sentences, generalized — not just about the one example site), "## Typical primary user" (who usually uses this kind of app), "## Common modules / features" (a bullet list of functional areas this type of app commonly has — generalize from the examples seen, but note which ones might be ${classification.siteType}-specific vs. universal), "## Typical key user flows" (the main things a user does in this kind of app), "## Common risk areas" (bullet list of which modules carry the most business/security risk across this category if broken — e.g. payments, auth, data deletion). Be concrete, not generic QA padding — but write it so it's useful for a DIFFERENT site in this same category, not only the one example given. If a section genuinely can't be inferred from the signals, write "Not enough signal to infer" under it rather than guessing.

Respond with ONLY the Markdown document, no commentary before or after it.`;

  try {
    const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
    if (!text) return null;
    const cleaned = text.trim();
    // Sanity bounds — a wildly short/long response is more likely malformed than useful.
    if (cleaned.length < 80 || cleaned.length > 8000) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * Called once per session, right after classification completes. Does nothing (fast no-op) if
 * a doc for this site's CATEGORY already exists — from this site or any other previously-seen
 * site of the same category — by explicit design: never regenerated/diff-updated on later runs,
 * only captured once per category.
 */
export async function ensureSiteKnowledge(
  knowledgeBaseDir: string,
  hostname: string,
  signals: SiteIntelligenceSignals,
  classification: SiteClassification,
): Promise<{ content: string; isNew: boolean } | null> {
  const siteType = classification.siteType;
  const existing = await loadSiteKnowledge(knowledgeBaseDir, siteType);
  if (existing) return { content: existing, isNew: false };

  const generated = await generateWalkthroughDoc(hostname, signals, classification);
  if (!generated) return null;

  const withHeader = `# ${siteType}\n\n_First captured from ${hostname} on ${new Date().toISOString()}_\n\n${generated}\n`;
  await saveSiteKnowledge(knowledgeBaseDir, siteType, withHeader);
  return { content: withHeader, isNew: true };
}
