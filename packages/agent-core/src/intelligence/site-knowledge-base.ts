// Per-DOMAIN-CATEGORY knowledge base: gives the agent persistent memory of what a given KIND
// of application typically looks like, across sessions and across different sites. Keyed by
// business category (classification.siteType — fintech, ecommerce, saas-dashboard, ...), not
// by hostname: the first fintech site ever explored captures fintech.md; the next, entirely
// different fintech site reuses that same doc instead of starting from zero, because it's the
// same KIND of application.
//
// The doc itself is still cheap on every session (loaded or reused, no LLM call) — but unlike
// the original "once per category, forever" design, every site's signals are now POOLED
// (deduped by hostname) in a sidecar file, and the doc is periodically REGENERATED from that
// whole pool once enough new sites have contributed. This lets the doc actually broaden and
// correct itself as more real examples of a category are seen, while keeping the LLM call rare
// and controlled (a threshold, not a per-session cost) — regenerating on every single session
// would reintroduce exactly the cost problem the original "once only" rule existed to avoid.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteClassification, SiteIntelligenceSignals, SiteType } from '@qa/shared';
import { callLLM, hasAnyLLMKey } from '@qa/shared';

// Same documented real-world latency precedent as every other AI call in this codebase
// (visual-review.ts, ai-report-enhance.ts, requirement-expand-ai.ts) — Gemini in particular
// can take 15-35s+; 50s is the safe default across all supported providers.
const REQUEST_TIMEOUT_MS = 50000;

// How many NEW distinct sites of a category must be seen since the doc was last (re)generated
// before spending another LLM call to refresh it. Deliberately not "every session" — see the
// file-level comment for why.
const REGEN_THRESHOLD = 5;

function docPath(knowledgeBaseDir: string, siteType: SiteType): string {
  return join(knowledgeBaseDir, `${siteType}.md`);
}

function poolPath(knowledgeBaseDir: string, siteType: SiteType): string {
  return join(knowledgeBaseDir, `${siteType}.signals.json`);
}

function metaPath(knowledgeBaseDir: string, siteType: SiteType): string {
  return join(knowledgeBaseDir, `${siteType}.meta.json`);
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

interface PooledSiteSignal {
  hostname: string;
  capturedAt: string;
  title: string;
  headings: string[];
  buttonAndLinkTexts: string[];
  inputTypes: string[];
  urlPaths: string[];
  confidence: number;
  inferredJourneys: string[];
}

interface RegenMeta {
  lastRegeneratedAt: string;
  sitesAtLastRegen: number;
}

async function loadPool(knowledgeBaseDir: string, siteType: SiteType): Promise<PooledSiteSignal[]> {
  const path = poolPath(knowledgeBaseDir, siteType);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function savePool(knowledgeBaseDir: string, siteType: SiteType, pool: PooledSiteSignal[]): Promise<void> {
  await mkdir(knowledgeBaseDir, { recursive: true });
  await writeFile(poolPath(knowledgeBaseDir, siteType), JSON.stringify(pool, null, 2), 'utf-8');
}

async function loadRegenMeta(knowledgeBaseDir: string, siteType: SiteType): Promise<RegenMeta | null> {
  const path = metaPath(knowledgeBaseDir, siteType);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function saveRegenMeta(knowledgeBaseDir: string, siteType: SiteType, meta: RegenMeta): Promise<void> {
  await mkdir(knowledgeBaseDir, { recursive: true });
  await writeFile(metaPath(knowledgeBaseDir, siteType), JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Record this site's signals into the category's pool, deduped by hostname (a repeat run against
 * the same site refreshes its entry rather than adding a duplicate — the pool tracks distinct
 * SITES seen, not session count). Returns the updated pool.
 */
async function recordSiteSignal(
  knowledgeBaseDir: string,
  siteType: SiteType,
  hostname: string,
  signals: SiteIntelligenceSignals,
  classification: SiteClassification,
): Promise<PooledSiteSignal[]> {
  const pool = await loadPool(knowledgeBaseDir, siteType);
  const entry: PooledSiteSignal = {
    hostname,
    capturedAt: new Date().toISOString(),
    title: signals.title,
    headings: signals.headings.slice(0, 15),
    buttonAndLinkTexts: [...signals.buttonTexts, ...signals.linkTexts].slice(0, 30),
    inputTypes: signals.inputTypes.slice(0, 15),
    urlPaths: signals.urlPaths.slice(0, 30),
    confidence: classification.confidence,
    inferredJourneys: classification.inferredJourneys,
  };
  const withoutThisHost = pool.filter((p) => p.hostname !== hostname);
  const updated = [...withoutThisHost, entry];
  await savePool(knowledgeBaseDir, siteType, updated);
  return updated;
}

function renderPoolForPrompt(pool: PooledSiteSignal[]): string {
  return pool
    .map(
      (p, i) => `Example site ${i + 1} (${p.hostname}):
  Title: ${p.title}
  Headings: ${p.headings.join(', ') || '(none)'}
  Button/link text: ${p.buttonAndLinkTexts.join(', ') || '(none)'}
  Input types: ${p.inputTypes.join(', ') || '(none)'}
  Routes: ${p.urlPaths.join(', ') || '(none)'}
  Inferred journeys: ${p.inferredJourneys.join(', ') || 'none'}`,
    )
    .join('\n\n');
}

const DOC_SECTIONS_PROMPT = `Write the doc with these sections: "## What this category of application typically is" (1-2 sentences, generalized — not just about any one example site), "## Typical primary user" (who usually uses this kind of app), "## Common modules / features" (a bullet list of functional areas this type of app commonly has — generalize across the examples, noting which look universal to the category vs. specific to only one or two of the examples), "## Typical key user flows" (the main things a user does in this kind of app), "## Common risk areas" (bullet list of which modules carry the most business/security risk across this category if broken — e.g. payments, auth, data deletion). Be concrete, not generic QA padding — but write it so it's useful for a DIFFERENT site in this same category, not only the examples given. If a section genuinely can't be inferred from the signals, write "Not enough signal to infer" under it rather than guessing.

Respond with ONLY the Markdown document, no commentary before or after it.`;

/**
 * Gemini-based application walkthrough — synthesizes what recon/classification gathered from
 * THIS ONE example site (the first-ever capture for a category — see ensureSiteKnowledge).
 * Written to generalize: explicitly told this will be reused as a reference for OTHER, different
 * sites of the same category, not just the one it was captured from. Same hybrid discipline as
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

${DOC_SECTIONS_PROMPT}`;

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
 * Same idea as generateWalkthroughDoc, but synthesizing across EVERY pooled site of this
 * category at once instead of a single example — this is what lets the doc genuinely broaden
 * ("every example so far has X, but only some have Y") rather than staying frozen on whatever
 * the first-ever site happened to look like.
 */
async function generateWalkthroughDocFromPool(
  siteType: SiteType,
  pool: PooledSiteSignal[],
): Promise<string | null> {
  if (!hasAnyLLMKey()) return null;

  const prompt = `You are documenting a CATEGORY of web application for a QA team, based on ${pool.length} real example sites of this category they've crawled over time. This doc will be reused as reference context for OTHER, different websites that get classified into the same category later — so describe the general pattern this category of application follows across ALL the examples, not just one of them.

Category: ${siteType}

${renderPoolForPrompt(pool)}

${DOC_SECTIONS_PROMPT}`;

  try {
    const text = await callLLM(prompt, REQUEST_TIMEOUT_MS);
    if (!text) return null;
    const cleaned = text.trim();
    if (cleaned.length < 80 || cleaned.length > 8000) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * Called once per session, right after classification completes. Always records this site's
 * signals into the category's pool (deduped by hostname). If no doc exists yet for this
 * category, generates one from this single site (cheap, unchanged first-run path). If a doc
 * already exists, it's reused as-is UNLESS enough new distinct sites have been pooled since the
 * last (re)generation to cross REGEN_THRESHOLD, in which case it's regenerated from the whole
 * pool — broadening/correcting the doc from real accumulated examples, not just the first one.
 */
export async function ensureSiteKnowledge(
  knowledgeBaseDir: string,
  hostname: string,
  signals: SiteIntelligenceSignals,
  classification: SiteClassification,
): Promise<{ content: string; isNew: boolean; refreshed?: boolean; poolSize?: number } | null> {
  const siteType = classification.siteType;
  const pool = await recordSiteSignal(knowledgeBaseDir, siteType, hostname, signals, classification);
  const existing = await loadSiteKnowledge(knowledgeBaseDir, siteType);

  if (!existing) {
    const generated = await generateWalkthroughDoc(hostname, signals, classification);
    if (!generated) return null;
    const withHeader = `# ${siteType}\n\n_First captured from ${hostname} on ${new Date().toISOString()}_\n\n${generated}\n`;
    await saveSiteKnowledge(knowledgeBaseDir, siteType, withHeader);
    await saveRegenMeta(knowledgeBaseDir, siteType, { lastRegeneratedAt: new Date().toISOString(), sitesAtLastRegen: pool.length });
    return { content: withHeader, isNew: true, poolSize: pool.length };
  }

  const meta = await loadRegenMeta(knowledgeBaseDir, siteType);
  const sitesAtLastRegen = meta?.sitesAtLastRegen ?? 1; // doc existed before meta tracking began — assume 1 (the original capture)
  const newSitesSinceRegen = pool.length - sitesAtLastRegen;

  if (newSitesSinceRegen >= REGEN_THRESHOLD) {
    const regenerated = await generateWalkthroughDocFromPool(siteType, pool);
    if (regenerated) {
      const withHeader = `# ${siteType}\n\n_Refreshed from ${pool.length} pooled sites on ${new Date().toISOString()}_\n\n${regenerated}\n`;
      await saveSiteKnowledge(knowledgeBaseDir, siteType, withHeader);
      await saveRegenMeta(knowledgeBaseDir, siteType, { lastRegeneratedAt: new Date().toISOString(), sitesAtLastRegen: pool.length });
      return { content: withHeader, isNew: false, refreshed: true, poolSize: pool.length };
    }
    // Regeneration failed (no key / LLM error) — keep serving the existing doc, same
    // additive-only discipline as everywhere else: a refresh attempt never blocks the session.
    // Still record the attempt (bumping sitesAtLastRegen without touching lastRegeneratedAt),
    // so a real LLM error doesn't cause a retry on every single future session once past
    // threshold — the next attempt waits for another REGEN_THRESHOLD new sites, same as a
    // successful refresh would.
    await saveRegenMeta(knowledgeBaseDir, siteType, {
      lastRegeneratedAt: meta?.lastRegeneratedAt ?? new Date().toISOString(),
      sitesAtLastRegen: pool.length,
    });
  }

  return { content: existing, isNew: false, poolSize: pool.length };
}
