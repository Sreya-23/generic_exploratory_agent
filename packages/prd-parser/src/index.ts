import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';

const require = createRequire(import.meta.url);

export interface ParsedPrd {
  features: string[];
  constraints: string[];
  rawText: string;
  filename?: string;
  /** Short human-readable overview for chat / reports */
  overview: string;
  /** Per-feature acceptance criteria / user stories (aligned with features[]) */
  featureCriteria: string[];
}

const SKIP_LINE =
  /^(table of contents|toc|appendix|revision history|confidential|page \d+|overview$|out of scope|success criteria|constraints?$|requirements?$|purpose$|audience$|test credentials)/i;

const JUNK_FEATURE =
  /^(s document|document \(prd\)|exploratory qa|sample|prd$|version|overview|constraints?|requirements?)/i;

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/** Prefer explicit Feature titles; fall back to user stories / bullets */
function extractFeatures(text: string): string[] {
  const features: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    let line = normalizeLine(raw)
      .replace(/^feature\s*[:\-–—]\s*/i, '')
      .replace(/^#+\s*/, '');
    if (!line || line.length < 4 || line.length > 160) return;
    if (SKIP_LINE.test(line) || JUNK_FEATURE.test(line)) return;
    // Drop dangling fragments from PDF line-wrap ("to browse the product...")
    if (/^(to|and|or|with|for|from|that|which|must|shall|should)\b/i.test(line)) return;
    // Drop pure requirement fragments that are not feature names
    if (/^(the system|users? must|testers? must|exploration|empty |invalid )/i.test(line)) return;

    const key = line.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    features.push(line);
  };

  // 1) Explicit "Feature: Name" (best signal — md and pdf)
  for (const m of text.matchAll(/(?:^|\n)\s*(?:#{1,4}\s*)?Feature\s*[:\-–—]\s*(.+)/gi)) {
    push(m[1]);
  }
  // If we already have clear Feature: titles, use those only (avoid noisy user-story dupes)
  if (features.length >= 3) {
    return features.slice(0, 12);
  }

  // 2) Markdown headings that look like feature names
  for (const m of text.matchAll(/(?:^|\n)#{2,3}\s+(?!Overview|Constraints|Out of Scope|Success|\d+\.)(.+)/gi)) {
    const h = normalizeLine(m[1]);
    if (/^feature\b/i.test(h) || /^(user login|add to cart|view cart|checkout|logout|product inventory)/i.test(h)) {
      push(h.replace(/^feature\s*[:\-–—]\s*/i, ''));
    }
  }
  if (features.length >= 3) {
    return features.slice(0, 12);
  }

  // 3) User stories
  for (const m of text.matchAll(/As a .+?, I want to (.+?) so that .+/gi)) {
    push(m[1]);
  }
  for (const m of text.matchAll(/As a .+?, I want (.+?)(?:\.|$)/gi)) {
    push(m[1]);
  }

  // 4) Fallback: numbered / bullet lines with capability verbs (only if few features)
  if (features.length < 3) {
    for (const m of text.matchAll(/^\s*(?:[-*•]|\d+[.)])\s+(.{12,120})$/gm)) {
      const line = normalizeLine(m[1]);
      if (/\b(login|cart|checkout|search|browse|logout|inventory|product|add to cart)\b/i.test(line)) {
        push(line);
      }
    }
  }

  return features.slice(0, 12);
}

function extractConstraints(text: string): string[] {
  const constraints: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = normalizeLine(line);
    const lower = trimmed.toLowerCase();
    if (
      trimmed.length > 20 &&
      trimmed.length < 400 &&
      (lower.includes('must') ||
        lower.includes('shall') ||
        lower.includes('should not') ||
        lower.includes('validate') ||
        lower.includes('required') ||
        lower.includes('constraint') ||
        lower.includes('cannot') ||
        lower.includes('must not'))
    ) {
      constraints.push(trimmed);
    }
  }
  return [...new Set(constraints)].slice(0, 20);
}

async function extractPdfText(buffer: Buffer, filePath?: string): Promise<string> {
  // Prefer system pdftotext when available (more reliable than pdf-parse ESM quirks)
  if (filePath) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout?.trim()) return stdout;
    } catch {
      /* fall through to pdf-parse */
    }
  }

  // Import the library entry (not package root) to avoid pdf-parse debug-mode crash under ESM
  const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
    data: Buffer,
  ) => Promise<{ text: string; numpages?: number }>;
  const result = await pdfParse(buffer);
  return result.text ?? '';
}

async function readPrdText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);

  if (ext === '.pdf') {
    const text = await extractPdfText(buffer, filePath);
    if (!text.trim()) {
      throw new Error(
        'PDF uploaded but no extractable text found (scanned image PDFs are not supported yet)',
      );
    }
    return text;
  }

  if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.csv') {
    return buffer.toString('utf-8');
  }

  // Attempt UTF-8 for unknown / doc-like extensions; fail clearly if binary garbage
  const asText = buffer.toString('utf-8');
  const replacementCount = (asText.match(/\uFFFD/g) ?? []).length;
  if (replacementCount > 20 || asText.trim().length < 40) {
    throw new Error(
      `Unsupported PRD format "${ext}". Upload a .pdf, .md, or .txt file.`,
    );
  }
  return asText;
}

function buildOverview(features: string[], constraints: string[], filename?: string): string {
  const name = filename ?? 'PRD';
  return [
    `Parsed **${name}**: extracted **${features.length}** feature(s) and **${constraints.length}** constraint(s).`,
    features.length
      ? `Top features:\n${features
          .slice(0, 8)
          .map((f, i) => `${i + 1}. ${f.slice(0, 120)}`)
          .join('\n')}`
      : 'No clear features found — check that the PRD has readable text.',
  ].join('\n\n');
}

/** Pull user-story / acceptance lines under each Feature: block */
export function extractFeatureCriteria(text: string, features: string[]): string[] {
  const globalStories = [...text.matchAll(/As a .+?(?:\.|$)/gi)].map((m) =>
    normalizeLine(m[0]).slice(0, 180),
  );

  return features.map((feature) => {
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(
      `(?:Feature\\s*[:\\-–—]\\s*|#{2,4}\\s*Feature\\s*[:\\-–—]\\s*)${escaped}([\\s\\S]*?)(?=(?:\\n\\s*(?:Feature\\s*[:\\-–—]|#{2,4}\\s*Feature\\s*[:\\-–—]|#{2}\\s)|$))`,
      'i',
    );
    const m = text.match(blockRe);
    const block = m?.[1] ?? '';
    const story = block.match(/As a .+?(?:\.|$)/i)?.[0];
    if (story) return normalizeLine(story).slice(0, 180);
    const bullet = block.match(/^\s*[-*•]\s+(.{12,160})$/m)?.[1];
    if (bullet) return normalizeLine(bullet).slice(0, 180);

    // PDF-friendly: match a global user story by shared keywords with the feature name
    const keys = feature
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    let best: { score: number; text: string } | null = null;
    for (const s of globalStories) {
      const lower = s.toLowerCase();
      const score = keys.filter((k) => lower.includes(k)).length;
      if (score > 0 && (!best || score > best.score)) best = { score, text: s };
    }
    if (best && best.score >= 1) return best.text;

    return `Exercise "${feature}" — happy, negative, and interruption paths`;
  });
}

function isGenericCriteria(c: string): boolean {
  return /^Exercise "/i.test(c);
}

/** Prefer companion .md/.txt when PDF text is title-only (common for short sample PDFs). */
async function loadCompanionText(filePath: string): Promise<string | null> {
  const base = basename(filePath)
    .replace(/^prd-/i, '')
    .replace(/\.(pdf|PDF)$/i, '');
  const dir = dirname(filePath);
  const candidates = [
    join(dir, `${base}.md`),
    join(dir, `${base}.txt`),
    join(process.cwd(), 'sample-prds', `${base}.md`),
    join(process.cwd(), 'sample-prds', `${base}.txt`),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      const text = await readFile(c, 'utf-8');
      if (text.trim().length > 40) return text;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function parsePrd(filePath: string): Promise<ParsedPrd> {
  const rawText = await readPrdText(filePath);
  const features = extractFeatures(rawText);
  let constraints = extractConstraints(rawText);
  const filename = basename(filePath);
  let featureCriteria = extractFeatureCriteria(rawText, features);

  if (features.length && featureCriteria.every(isGenericCriteria)) {
    const companion = await loadCompanionText(filePath);
    if (companion) {
      const enriched = extractFeatureCriteria(companion, features);
      if (enriched.some((c) => !isGenericCriteria(c))) {
        featureCriteria = enriched;
      }
      if (constraints.length === 0) {
        constraints = extractConstraints(companion);
      }
    }
  }

  return {
    features,
    constraints,
    rawText: rawText.slice(0, 100_000),
    filename,
    overview: buildOverview(features, constraints, filename),
    featureCriteria,
  };
}

/** Build a markdown PRD coverage summary for chat + report export */
export function formatPrdCoverageMarkdown(input: {
  prdFilename?: string;
  featuresExtracted: string[];
  constraintsExtracted: string[];
  featureDetails?: Array<{ requirementId: string; name: string; criteria?: string }>;
  featureResults: Array<{
    feature: string;
    variant: string;
    status: string;
    notes: string;
    findingsCount: number;
    requirementId?: string;
    taskId?: string;
    criteria?: string;
  }>;
  gaps: string[];
  blocked: string[];
  findingDiffMarkdown?: string;
}): string {
  const lines: string[] = [
    `# PRD Coverage Summary`,
    ``,
    `**PRD file:** ${input.prdFilename ?? '(uploaded PRD)'}`,
    ``,
    `## Features & acceptance criteria (${input.featuresExtracted.length})`,
  ];

  const details =
    input.featureDetails ??
    input.featuresExtracted.map((name, i) => ({
      requirementId: `F${i + 1}`,
      name,
      criteria: undefined as string | undefined,
    }));

  for (const d of details) {
    lines.push(`### ${d.requirementId} — ${d.name}`);
    lines.push(d.criteria ? `_${d.criteria}_` : `_No acceptance criteria extracted_`);
    lines.push('');
  }

  if (input.constraintsExtracted.length) {
    lines.push(`## Constraints extracted (${input.constraintsExtracted.length})`);
    for (const c of input.constraintsExtracted) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  lines.push(`## Traceability (requirement → task → result)`);
  lines.push(`| Req ID | Task ID | Feature | Variant | Status | Findings | Notes |`);
  lines.push(`|--------|---------|---------|---------|--------|----------|-------|`);
  for (const r of input.featureResults) {
    lines.push(
      `| ${r.requirementId ?? '—'} | ${r.taskId ?? '—'} | ${r.feature.slice(0, 40).replace(/\|/g, '/')} | ${r.variant} | ${r.status} | ${r.findingsCount} | ${r.notes.slice(0, 70).replace(/\|/g, '/')} |`,
    );
  }
  lines.push('');

  if (input.gaps.length) {
    lines.push(`## Gaps (PRD feature, no matching UI found)`);
    for (const g of input.gaps) lines.push(`- ${g}`);
    lines.push('');
  }

  if (input.blocked.length) {
    lines.push(`## Blocked`);
    for (const b of input.blocked) lines.push(`- ${b}`);
    lines.push('');
  }

  if (input.findingDiffMarkdown) {
    lines.push(input.findingDiffMarkdown);
    lines.push('');
  }

  const tested = input.featureResults.filter((r) =>
    ['tested', 'passed', 'failed'].includes(r.status),
  ).length;
  const passed = input.featureResults.filter((r) => r.status === 'passed').length;
  const failed = input.featureResults.filter((r) => r.status === 'failed').length;
  const skipped = input.featureResults.filter((r) => r.status === 'skipped').length;

  lines.push(`## Totals`);
  lines.push(`- Variants executed: ${tested}`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Failed / findings: ${failed}`);
  lines.push(`- Gaps: ${input.gaps.length}`);
  lines.push(`- Blocked: ${input.blocked.length}`);
  lines.push(`- Skipped (after smoke fail): ${skipped}`);

  return lines.join('\n');
}
