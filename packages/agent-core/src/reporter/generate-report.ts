import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type {
  AccessMapEntry,
  EnvironmentCheck,
  ExplorationPlan,
  Finding,
  FlowTask,
  HealthScore,
  SessionState,
  Severity,
} from '@qa/shared';
import { computeHealthScore, FLOW_TITLES, parseListLikeText } from '@qa/shared';
import { dedupeFindingsWithAI, summarizeWithAI, validateFindingsWithAI } from './ai-report-enhance.js';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Inline a screenshot as a base64 data URI directly into the report HTML, rather than
 * printing its absolute local filesystem path as inert text. This is what actually makes a
 * generated report a durable, self-contained artifact: the image bytes live inside report.html
 * itself, so the report keeps showing its evidence even if the session folder it was generated
 * from is later deleted, moved, or the API server that served it restarts — all of which
 * otherwise silently orphaned every screenshot reference (confirmed: evidence paths were only
 * ever rendered as plain escaped text, never as an <img>, so screenshots never actually
 * displayed in the report at all before this — this is what "retaining" them means in practice).
 * Falls back to the bare filename (not the meaningless local absolute path) if the file can't
 * be read at generation time.
 */
function embedEvidenceHtml(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    try {
      const data = readFileSync(path).toString('base64');
      // NOT loading="lazy" — confirmed via a real headless-browser test that a long report
      // (many findings, most images far down the page) never triggers the lazy-load fetch
      // during a Print-to-PDF/PDF-export pass (0 of 30 images loaded even after the page's
      // own `load` event), so every screenshot silently renders as blank space in the
      // exported PDF despite being correctly embedded in the HTML. Eager loading fixed it
      // (29 of 30 loaded immediately in the same test) at the cost of loading all images
      // up front in the live web view, which is an acceptable trade for a report whose
      // primary export path is a PDF a reader expects to see evidence in.
      return `<a href="data:${mime};base64,${data}" target="_blank" rel="noopener"><img class="evidence-shot" src="data:${mime};base64,${data}" alt="${escapeHtml(basename(path))}" loading="eager" /></a>`;
    } catch {
      /* file missing/unreadable at generation time — fall through to filename-only display */
    }
  }
  return `<span class="evidence-file">${escapeHtml(basename(path))}</span>`;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface FlowCoverageRow {
  area: string;
  flowClass: string;
  title: string;
  description: string;
  findingsCount: number;
  /** How to re-run / reproduce this test flow */
  steps: string[];
}

export interface AreaFindingGroup {
  area: string;
  count: number;
  bySeverity: SeverityCounts;
  findings: Finding[];
}

/** Ensure every finding has concrete steps to reproduce for the report. */
export function withReproSteps(finding: Finding, targetUrl: string): Finding {
  if (finding.steps.length > 0) return finding;
  return {
    ...finding,
    steps: [
      `Open ${targetUrl}`,
      `Navigate to the relevant ${finding.area || 'application'} UI`,
      `Reproduce: ${finding.title}`,
      `Confirm actual result: ${finding.actual}`,
    ],
  };
}

function buildFlowSteps(task: FlowTask, targetUrl: string): string[] {
  const action =
    task.description?.trim() ||
    `Execute flow "${task.title || flowTitle(task.flowClass)}" (${task.flowClass})`;
  return [
    `Open ${targetUrl}`,
    action,
    'Observe UI/API behavior and record any defects (expected vs actual)',
  ];
}

export interface SessionReport {
  markdown: string;
  html: string;
  summary: {
    /** Count of actual bugs — excludes info-severity items, which aren't defects */
    total: number;
    bySeverity: SeverityCounts;
    healthScore: HealthScore;
    executiveSummary: string;
    recommendedNextSteps: string[];
    flowsCovered: FlowCoverageRow[];
    findingsByArea: AreaFindingGroup[];
    /** Bug findings only (severity !== 'info'), steps-to-reproduce always populated */
    findings: Finding[];
    /** Info-severity items — not defects, kept separate: discovered endpoints, coverage
     *  summaries, confirmation checks that may be useful context for future exploration */
    infoFindings: Finding[];
    infoByArea: AreaFindingGroup[];
  };
}

function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts = emptyCounts();
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const si = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (si !== 0) return si;
    return a.title.localeCompare(b.title);
  });
}

/** Deduplicate findings that share the same title + actual outcome. */
function normalizeTitleTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Same page + same actual DOM element — a stronger root-cause signal than title wording,
 * so this alone is enough to merge even across different areas/severities/phrasing. */
function sameTarget(a: Finding, b: Finding): boolean {
  return !!a.pageUrl && !!a.targetSelector && a.pageUrl === b.pageUrl && a.targetSelector === b.targetSelector;
}

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const exact: Finding[] = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.area}|${f.title}|${f.actual}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    exact.push(f);
  }

  // Second pass: merge NEAR-duplicates. The same underlying defect frequently gets
  // surfaced by several independent flows (action-inventory, journey, keyboard-nav all
  // separately clicking the same broken element) — exact-string dedup above can't catch
  // that, since each flow words its finding slightly differently. This groups by
  // severity+area and folds titles with high token overlap into one finding instead of
  // reporting the same defect several times over, which is what actually made past
  // reports read as repetitive/shallow rather than the underlying checks themselves.
  const merged: Finding[] = [];
  const altTitles = new Map<string, Set<string>>();

  for (const f of exact) {
    const titleTokens = normalizeTitleTokens(f.title);
    // Strongest signal first: same page + same actual element, regardless of wording —
    // and even across severity/area, since a locator match is firmer evidence of "same
    // defect" than either of those. Title-overlap is the fallback for findings that don't
    // carry a target locator (most flows still don't attach one).
    const target =
      merged.find((m) => sameTarget(f, m)) ??
      merged.find(
        (m) =>
          m.severity === f.severity &&
          m.area === f.area &&
          // Only merge across DIFFERENT tasks — this pass exists for "the same defect
          // independently found by two different flows," not "one flow enumerating several
          // genuinely distinct instances" (one finding per device/zoom-level/DOM-element),
          // which share the same task and near-identical wording by construction but are
          // each independently meaningful. Findings without a taskId (older sessions, before
          // this was tracked) fall back to title-overlap alone rather than being unmergeable.
          (!m.taskId || !f.taskId || m.taskId !== f.taskId) &&
          tokenOverlap(titleTokens, normalizeTitleTokens(m.title)) >= 0.6,
      );
    if (!target) {
      merged.push({ ...f, evidence: [...f.evidence] });
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[target.severity]) {
      target.severity = f.severity;
    }
    if (!altTitles.has(target.id)) altTitles.set(target.id, new Set());
    if (f.title !== target.title) altTitles.get(target.id)!.add(f.title);
    for (const e of f.evidence) if (!target.evidence.includes(e)) target.evidence.push(e);
  }

  for (const m of merged) {
    const alts = altTitles.get(m.id);
    if (alts && alts.size > 0) {
      m.actual = `${m.actual} (also observed via ${alts.size} other check${alts.size > 1 ? 's' : ''}: ${[...alts].slice(0, 3).join('; ')})`;
    }
  }

  return merged;
}

function flowTitle(flowClass: string): string {
  return FLOW_TITLES[flowClass] ?? flowClass.replace(/-/g, ' ');
}

function findingMatchesTask(finding: Finding, task: FlowTask): boolean {
  // taskId is the authoritative link (set by the orchestrator when the finding is raised).
  // Fall back to fuzzy area/title matching only for legacy findings that predate taskId.
  if (finding.taskId) return finding.taskId === task.id;
  const area = finding.area.toLowerCase();
  const title = finding.title.toLowerCase();
  const fc = task.flowClass.toLowerCase();
  return (
    area.includes(fc) ||
    title.includes(fc.replace(/-/g, ' ')) ||
    finding.area === task.area
  );
}

function buildFlowCoverage(
  plan: ExplorationPlan | undefined,
  findings: Finding[],
  targetUrl: string,
): FlowCoverageRow[] {
  if (!plan?.tasks?.length) return [];
  return plan.tasks.map((task) => ({
    area: task.area,
    flowClass: task.flowClass,
    title: task.title || flowTitle(task.flowClass),
    description: task.description || '',
    findingsCount: findings.filter((f) => findingMatchesTask(f, task)).length,
    steps: buildFlowSteps(task, targetUrl),
  }));
}

function groupFindingsByArea(findings: Finding[]): AreaFindingGroup[] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.area || 'general';
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([area, list]) => {
      const sorted = sortFindings(list);
      return {
        area,
        count: sorted.length,
        bySeverity: countBySeverity(sorted),
        findings: sorted,
      };
    })
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

function groupFlowsByArea(flows: FlowCoverageRow[]): Map<string, FlowCoverageRow[]> {
  const map = new Map<string, FlowCoverageRow[]>();
  for (const f of flows) {
    const list = map.get(f.area) ?? [];
    list.push(f);
    map.set(f.area, list);
  }
  return map;
}

function buildExecutiveSummary(
  state: SessionState,
  counts: SeverityCounts,
  total: number,
  flowCount: number,
  health: HealthScore,
): string {
  const healthClause = `**Health Score: ${health.grade} (${health.score}/100).** `;
  const site = state.classification?.siteType;
  const siteClause = site && site !== 'generic' ? ` Classified as ${site}.` : '';
  const risk =
    counts.critical > 0
      ? 'Critical issues require immediate attention before release.'
      : counts.high > 0
        ? 'High-severity issues in core flows should be fixed before release.'
        : counts.medium > 0
          ? 'No critical/high blockers; medium issues should be triaged into the backlog.'
          : total === 0
            ? 'No issues recorded during this pass — consider a deeper depth or more areas.'
            : 'Only low/info observations; overall risk appears limited.';

  const depth = state.config.depth;
  const tasks = `${state.progress.completedTasks}/${state.progress.totalTasks} tasks`;
  const flows = flowCount > 0 ? ` Covered ${flowCount} exploration flow${flowCount === 1 ? '' : 's'}.` : '';
  return `${healthClause}Explored ${state.config.targetUrl} at ${depth} depth (${tasks}).${siteClause}${flows} Recorded ${total} finding${total === 1 ? '' : 's'} (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium). ${risk}`;
}

function buildRecommendedNextSteps(
  findings: Finding[],
  counts: SeverityCounts,
): string[] {
  const steps: string[] = [];
  const top = sortFindings(findings).filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );

  if (top.length > 0) {
    steps.push(`Fix highest-priority issue first: "${top[0].title}" (${top[0].severity}).`);
  } else if (counts.medium > 0) {
    steps.push('Triage medium-severity findings into the product backlog.');
  } else if (findings.length === 0) {
    steps.push('Re-run at standard/deep depth or add chaos/security areas for broader coverage.');
  } else {
    steps.push('Review low/info findings for UX polish and accessibility gaps.');
  }

  const automatable = findings.filter((f) => f.automationCandidate);
  if (automatable.length > 0) {
    steps.push(
      `Add regression coverage for ${automatable.length} automation candidate${automatable.length === 1 ? '' : 's'} (marked in findings).`,
    );
  } else {
    steps.push('Promote stable repro cases into automated regression tests.');
  }

  const areas = new Set(findings.map((f) => f.area.split('/')[0] || f.area));
  if (areas.size > 0) {
    steps.push(`Schedule deeper manual review for: ${[...areas].slice(0, 5).join(', ')}.`);
  } else {
    steps.push('Expand exploration areas (API, security, chaos) on the next pass.');
  }

  return steps.slice(0, 5);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSeverityInline(c: SeverityCounts): string {
  return SEVERITY_ORDER.filter((s) => c[s] > 0)
    .map((s) => `${c[s]} ${s}`)
    .join(', ') || 'none';
}

// Same list-detection as the HTML report's withListFormatting — renders a real Markdown list
// when the field turns out to be a list crammed into one '; '/', '-joined sentence.
function formatExpectedActualMarkdown(label: string, text: string): string {
  const structured = parseListLikeText(text);
  if (!structured) return `**${label}:** ${text}`;
  const intro = structured.intro ? ` ${structured.intro}` : '';
  const items = structured.items.map((item) => `  - ${item}`).join('\n');
  return `**${label}:**${intro}\n${items}`;
}

function formatFindingMarkdown(f: Finding): string {
  const lines: string[] = [
    `#### [${f.severity.toUpperCase()}] ${f.title}`,
    '',
  ];
  if (f.preconditions) lines.push(`**Preconditions:** ${f.preconditions}`);
  lines.push('**Steps to reproduce:**');
  if (f.steps.length === 0) {
    lines.push('1. (no steps recorded)');
  } else {
    f.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  lines.push('');
  lines.push(formatExpectedActualMarkdown('Expected', f.expected));
  lines.push(formatExpectedActualMarkdown('Actual', f.actual));
  lines.push(
    `**Evidence:** ${f.evidence.length > 0 ? f.evidence.map((e) => basename(e)).join(', ') + ' (see HTML report for images)' : 'None attached'}`,
  );
  lines.push(`**Repro rate:** ${f.reproRate}`);
  lines.push(`**Automation candidate:** ${f.automationCandidate ? 'Yes' : 'No'}`);
  if (f.confidence) {
    lines.push(
      `**Confidence:** ${f.confidence === 'verified' ? 'Verified (multiple independent signals)' : 'Heuristic (spot-check recommended)'}` +
        (f.confidenceReason ? ` — ${f.confidenceReason}` : ''),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function formatFindingHtml(f: Finding, index: number, idPrefix: string = 'F'): string {
  const id = `${idPrefix}-${String(index + 1).padStart(3, '0')}`;
  const steps =
    f.steps.length > 0
      ? `<ol class="steps">${f.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
      : '<p class="muted"><em>(no steps recorded)</em></p>';
  const evidence =
    f.evidence.length > 0
      ? `<div class="evidence-shots">${f.evidence.map((e) => embedEvidenceHtml(e)).join('')}</div>`
      : '<p class="muted">None attached</p>';

  // Newlines in `actual`/`expected` (e.g. a consolidated finding listing several raw error
  // messages) need to survive into the rendered HTML — escapeHtml alone collapses them, since
  // whitespace inside a plain <p> renders as a single line.
  const withLineBreaks = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

  // Several check files build a single Finding.actual/expected string by joining a list with
  // '; '/', ' (there's nowhere else in the Finding shape to put a list) — this renders that
  // structure back out as a real <ul> instead of a wall of semicolons, matching the live
  // session UI's FindingCard.tsx treatment of the same fields.
  const withListFormatting = (s: string): string => {
    const structured = parseListLikeText(s);
    if (!structured) return withLineBreaks(s);
    const intro = structured.intro ? `${escapeHtml(structured.intro)} ` : '';
    const items = structured.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `${intro}<ul class="finding-list">${items}</ul>`;
  };

  const confidenceBadge = f.confidence
    ? `<span class="confidence-badge ${f.confidence}" title="${escapeHtml(f.confidenceReason ?? '')}">${f.confidence === 'verified' ? '✓ Verified' : '⚠ Heuristic'}</span>`
    : '';
  // The badge's title= tooltip is easy to miss entirely (no hover on touch, and invisible in
  // any copy-pasted or printed version of the report) — confidenceReason is exactly the kind
  // of context ("verified" doesn't mean "always reproduces") that shouldn't depend on a reader
  // thinking to hover over a small badge, so it's also shown as plain, always-visible text.
  const confidenceNote = f.confidenceReason
    ? `<p class="confidence-note"><span class="label">Confidence note</span>${escapeHtml(f.confidenceReason)}</p>`
    : '';

  return `
<article class="finding" data-severity="${escapeHtml(f.severity)}">
  <header class="finding-head">
    <span class="finding-id">${id}</span>
    <span class="sev-badge ${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
    <span class="area-chip">${escapeHtml(f.area)}</span>
    ${confidenceBadge}
  </header>
  <h4>${escapeHtml(f.title)}</h4>
  ${f.preconditions ? `<p class="pre"><span class="label">Preconditions</span>${escapeHtml(f.preconditions)}</p>` : ''}
  <div class="block"><span class="label">Steps to reproduce</span>${steps}</div>
  <div class="ea-grid">
    <div class="ea expected"><span class="label">Expected</span><div class="ea-text">${withListFormatting(f.expected)}</div></div>
    <div class="ea actual"><span class="label">Actual</span><div class="ea-text">${withListFormatting(f.actual)}</div></div>
  </div>
  ${confidenceNote}
  <div class="block"><span class="label">Evidence</span>${evidence}</div>
  <footer class="finding-foot">
    <span>Repro rate: <strong>${escapeHtml(f.reproRate)}</strong></span>
    <span>${f.automationCandidate ? 'Automation candidate: Yes' : 'Automation candidate: No'}</span>
  </footer>
</article>`;
}

function overallRisk(counts: SeverityCounts, total: number): { label: string; className: string } {
  if (counts.critical > 0) return { label: 'Critical', className: 'risk-critical' };
  if (counts.high > 0) return { label: 'High', className: 'risk-high' };
  if (counts.medium > 0) return { label: 'Medium', className: 'risk-medium' };
  if (total > 0) return { label: 'Low', className: 'risk-low' };
  return { label: 'Clear', className: 'risk-clear' };
}

function buildOverviewMarkdown(state: SessionState, flows: FlowCoverageRow[], findings: Finding[]): string {
  const journeys = state.classification?.inferredJourneys?.slice(0, 5).join(', ') || '—';
  const endpoints = state.discoveredApiEndpoints?.length ?? 0;
  const auth =
    state.authProbe?.requiresAuth === false
      ? 'No login required'
      : state.authProbe?.suggestedMethod
        ? `Auth: ${state.authProbe.suggestedMethod}`
        : state.config.credentials?.type && state.config.credentials.type !== 'none'
          ? `Auth: ${state.config.credentials.type}`
          : 'Auth: not probed';

  return [
    '## 1. Overview',
    '',
    `| | |`,
    `|---|---|`,
    `| **Target** | ${state.config.targetUrl} |`,
    `| **Status** | ${state.status} |`,
    `| **Depth** | ${state.config.depth} |`,
    `| **Areas selected** | ${state.config.areas.join(', ') || 'n/a'} |`,
    `| **Tasks completed** | ${state.progress.completedTasks} / ${state.progress.totalTasks} |`,
    `| **Flows exercised** | ${flows.length} |`,
    `| **Findings** | ${findings.length} |`,
    `| **Site type** | ${state.classification ? `${state.classification.siteType} (${Math.round(state.classification.confidence * 100)}%)` : 'not classified'} |`,
    `| **Inferred journeys** | ${journeys} |`,
    `| **Authentication** | ${auth} |`,
    `| **API endpoints discovered** | ${endpoints} |`,
    `| **Session ID** | ${state.id} |`,
    `| **Date** | ${state.updatedAt || state.createdAt} |`,
    '',
  ].join('\n');
}

function buildFlowsMarkdown(flows: FlowCoverageRow[]): string {
  if (flows.length === 0) {
    return ['## 2. Flows Tested', '', '_No plan tasks were recorded for this session._', ''].join('\n');
  }

  const byArea = groupFlowsByArea(flows);
  const lines: string[] = [
    '## 2. Flows Tested',
    '',
    `Exercised **${flows.length}** flows across **${byArea.size}** area${byArea.size === 1 ? '' : 's'}.`,
    '',
  ];

  for (const [area, rows] of byArea) {
    lines.push(`### ${area}`);
    lines.push('');
    for (const row of rows) {
      lines.push(`#### ${row.title}`);
      lines.push('');
      if (row.description) lines.push(`${row.description}`, '');
      lines.push(`**Findings:** ${row.findingsCount}`, '');
      lines.push('**Steps to reproduce:**');
      row.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * §2 — a lightweight hierarchical application map, built by grouping discoveredRoutes by
 * top-level path segment. Not a hand-curated feature tree (this codebase has no concept of
 * "Authentication" or "Settings" as named modules) — a real, evidence-based grouping of what
 * was actually discovered, which is what's actually available to build one from.
 */
/** The persistent per-CATEGORY knowledge-base doc (site-knowledge-base.ts), when one exists
 *  for this target's classified site type — generated once the first time that category is
 *  seen (from whichever site happened to be first), reused silently for every other site that
 *  classifies into the same category after. */
function buildSiteKnowledgeMarkdown(state: SessionState): string {
  if (!state.siteKnowledge) return '';
  return ['## Application Knowledge Base', '', state.siteKnowledge, ''].join('\n');
}

function buildApplicationMapMarkdown(state: SessionState): string {
  const routes = state.discoveredRoutes ?? [];
  if (routes.length === 0) return '';

  const groups = new Map<string, string[]>();
  for (const route of routes) {
    let path: string;
    try {
      path = new URL(route).pathname;
    } catch {
      path = route;
    }
    const segment = path.split('/').filter(Boolean)[0] ?? '';
    const key = segment || '(root)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(path);
  }

  const lines: string[] = ['## Application Map', '', 'Discovered routes grouped by top-level section:', ''];
  for (const [segment, paths] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- **/${segment}**`);
    for (const p of [...new Set(paths)].sort()) lines.push(`  - ${p}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildPageCoverageMarkdown(state: SessionState): string {
  const discovered = state.discoveredRoutes ?? [];
  const visited = new Set(state.visitedRoutes ?? []);
  if (discovered.length === 0) return '';

  const notVisited = discovered.filter((r) => !visited.has(r));
  const visitedCount = discovered.length - notVisited.length;

  const lines: string[] = [
    '## Page Coverage',
    '',
    `**${visitedCount}/${discovered.length}** routes discovered on the landing page were actually visited during this session.`,
    '',
  ];
  if (notVisited.length > 0) {
    lines.push('**Not visited:**', '', ...notVisited.map((r) => `- ${r}`), '');
  }
  return lines.join('\n');
}

function shortenPageUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname === '/' ? u.pathname : u.pathname.replace(/\/$/, '')) + u.search || '/';
  } catch {
    return url;
  }
}

/**
 * The "does behavior differ between environments" grid — page × browser/device, ✓/✗ — that
 * distinguishes this from a generic per-mismatch findings list. Built from environmentChecks
 * (recorded for every check regardless of outcome), not from findings alone: findings only
 * ever record the ✗ side, so a page/environment pair that genuinely passed would otherwise
 * render as an indistinguishable blank rather than a real ✓.
 */
function buildEnvironmentMatrixMarkdown(state: SessionState): string {
  const checks = state.environmentChecks ?? [];
  if (checks.length === 0) return '';

  const pages = [...new Set(checks.map((c) => c.pageUrl))];

  // Browsers first (Chromium baseline pinned first), then devices — both in first-seen order
  // rather than alphabetical, so the grid reads baseline-then-comparison left to right
  // regardless of which page happened to be checked first.
  const browserEnvs: string[] = [];
  const deviceEnvs: string[] = [];
  for (const c of checks) {
    const bucket = c.kind === 'browser' ? browserEnvs : deviceEnvs;
    if (!bucket.includes(c.environment)) bucket.push(c.environment);
  }
  browserEnvs.sort((a, b) => (a === 'Chromium' ? -1 : b === 'Chromium' ? 1 : 0));
  const environments = [...browserEnvs, ...deviceEnvs];

  const byPageEnv = new Map<string, EnvironmentCheck>();
  for (const c of checks) byPageEnv.set(`${c.pageUrl}\u0000${c.environment}`, c);

  const lines: string[] = [
    '## Environment Comparison',
    '',
    'Every page × browser/device combination actually checked this session, and whether it matched the baseline — not just the individual mismatches listed under Findings.',
    '',
    `| Page | ${environments.join(' | ')} |`,
    `|------|${environments.map(() => '------').join('|')}|`,
  ];

  const notes: string[] = [];
  for (const pageUrl of pages) {
    const shortUrl = shortenPageUrl(pageUrl);
    const cells = environments.map((env) => {
      const c = byPageEnv.get(`${pageUrl}\u0000${env}`);
      if (!c) return '—';
      if (c.ok) return '✓';
      if (c.note) notes.push(`- **${shortUrl}** × ${env}: ${c.note}`);
      return '✗';
    });
    lines.push(`| ${shortUrl} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  if (notes.length > 0) {
    lines.push('**✗ details:**', '', ...notes, '');
  }
  return lines.join('\n');
}

/**
 * §18 — role/authorization access map, built from every UI-hidden link that was actually
 * checked for direct reachability this session. Reflects the SINGLE currently-authenticated
 * role, not a side-by-side Admin/Manager/User comparison — see AccessMapEntry's own comment
 * for why a true multi-role grid isn't built here (would need multiple real credential sets
 * and multiple real logins against what may be a live account).
 */
function buildAccessMapMarkdown(state: SessionState): string {
  const entries: AccessMapEntry[] = state.accessMap ?? [];
  if (entries.length === 0) return '';

  const lines: string[] = [
    '## Access Map',
    '',
    'UI-hidden links found in the DOM, checked for direct reachability under the current session\'s authenticated role. This is not a cross-role comparison (see note below) — only whether hiding something in the UI is actually backed by a real access control.',
    '',
    '| Feature/Link | Visible in UI | Directly Reachable | Note |',
    '|---|---|---|---|',
    ...entries.map(
      (e) =>
        `| ${e.feature.replace(/\|/g, '\\|')} | ✗ | ${e.directlyReachable ? '✓' : '✗'} | ${e.note ?? ''} |`,
    ),
    '',
    '_A true multi-role (Admin vs. Manager vs. User) access matrix would require multiple real credential sets and multiple real logins, which this session\'s single-login architecture doesn\'t support without added risk to a live account._',
    '',
  ];
  return lines.join('\n');
}

function buildActionInventoryMarkdown(state: SessionState): string {
  const inv = state.actionInventory;
  if (!inv || inv.totalFound === 0) return '';

  const lines: string[] = [
    '## Action Inventory',
    '',
    `Found **${inv.totalFound}** distinct action element(s) (buttons, icon-buttons, menu items, tabs) — ` +
      `tested **${inv.totalTested}**, skipped **${inv.totalSkippedRisky}** as risky (delete/pay/send-style actions).`,
    '',
    '| Outcome | Count |',
    '|---------|-------|',
    ...Object.entries(inv.byResult).map(([result, count]) => `| ${result} | ${count} |`),
    '',
  ];
  return lines.join('\n');
}

function buildFindingDiffMarkdown(state: SessionState): string {
  if (!state.findingDiff) return '';
  return ['## Regression vs Previous Run', '', state.findingDiff.markdown].join('\n');
}

function buildFindingsMarkdown(groups: AreaFindingGroup[], bySeverity: SeverityCounts): string {
  // Info-severity items are intentionally excluded here — they're not defects (computeHealthScore
  // already gives them zero weight), so they're broken out into their own "Additional Notes"
  // section below rather than diluting a section that's meant to be exclusively real bugs.
  const lines: string[] = [
    '## 3. Findings',
    '',
    '### Severity summary',
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| Critical | ${bySeverity.critical} |`,
    `| High     | ${bySeverity.high} |`,
    `| Medium   | ${bySeverity.medium} |`,
    `| Low      | ${bySeverity.low} |`,
    `| **Total** | **${groups.reduce((n, g) => n + g.count, 0)}** |`,
    '',
  ];

  if (groups.length === 0) {
    lines.push('_No findings were recorded during this exploration._', '');
    return lines.join('\n');
  }

  lines.push('### By area', '', '| Area | Findings |', '|------|----------|');
  for (const g of groups) {
    lines.push(`| ${g.area} | ${g.count} (${formatSeverityInline(g.bySeverity)}) |`);
  }

  lines.push('', '### Detailed findings', '');
  let idx = 0;
  for (const g of groups) {
    lines.push(`### Area: ${g.area} (${g.count})`, '');
    for (const f of g.findings) {
      idx += 1;
      lines.push(`#### ${idx}. [${f.severity.toUpperCase()}] ${f.title}`, '');
      const body = formatFindingMarkdown(f).split('\n').slice(2).join('\n');
      lines.push(body);
    }
  }
  return lines.join('\n');
}

/**
 * Info-severity items, broken out of the Findings section: not defects (expected and actual
 * agree by construction — "Endpoint exists" / "HTTP 200 with JSON response" — so they can't be
 * a bug), but still worth keeping as a record — discovered API endpoints, coverage summaries,
 * confirmation checks a future QA pass might want to build on.
 */
function buildInfoNotesMarkdown(groups: AreaFindingGroup[]): string {
  if (groups.length === 0) return '';
  const total = groups.reduce((n, g) => n + g.count, 0);
  const lines: string[] = [
    `## 4. Additional Notes (${total})`,
    '',
    '_Not defects — informational observations (discovered endpoints, coverage summaries, ' +
      'confirmation checks) that may be useful context for future exploration._',
    '',
  ];
  for (const g of groups) {
    lines.push(`### ${g.area} (${g.count})`, '');
    let idx = 0;
    for (const f of g.findings) {
      idx += 1;
      lines.push(`#### ${idx}. ${f.title}`, '');
      const body = formatFindingMarkdown(f).split('\n').slice(2).join('\n');
      lines.push(body);
    }
  }
  return lines.join('\n');
}

export async function generateSessionReport(state: SessionState): Promise<SessionReport> {
  const targetUrl = state.config.targetUrl;
  // Deterministic dedup always runs and is the guaranteed result; the AI pass on top of it
  // is a strict upgrade attempt that only ever REMOVES additional duplicates the token-
  // overlap heuristic missed — it returns null (keep going with what we have) on anything
  // from an unset API key to a malformed response, never blocking report generation.
  const deterministicallyDeduped = dedupeFindings(state.findings);
  const aiDeduped = await dedupeFindingsWithAI(deterministicallyDeduped).catch(() => null);
  let findings = sortFindings(aiDeduped ?? deterministicallyDeduped).map((f) =>
    withReproSteps(f, targetUrl),
  );

  // §30 — Validator pass: a second-opinion sanity check on heuristic-confidence findings,
  // additive only (see validateFindingsWithAI's own doc comment for why nothing is ever
  // dropped, only annotated).
  const validations = await validateFindingsWithAI(findings).catch(() => null);
  if (validations) {
    findings = findings.map((f, i) => {
      const v = validations.get(i);
      if (!v || v.plausible) return f;
      const note = `⚠ Automated second-pass check flagged this as possibly not a real defect: ${v.note}`;
      return {
        ...f,
        confidenceReason: f.confidenceReason ? `${f.confidenceReason} ${note}` : note,
      };
    });
  }
  // "info" severity is structurally not a defect — computeHealthScore already gives it zero
  // penalty and excludes it from the issue count — so it doesn't belong mixed into a
  // "Findings" list that's otherwise exclusively real bugs (a QA discovering "GET /api/x
  // returned 200 JSON" listed the same way as an actual defect reads as noise/confusion, not
  // a bug report). Split it out into its own section instead of dropping it: these are still
  // useful notes (discovered endpoints, coverage summaries, confirmation checks) worth keeping
  // for future exploration, just not co-mingled with things that need fixing.
  const bugFindings = findings.filter((f) => f.severity !== 'info');
  const infoFindings = findings.filter((f) => f.severity === 'info');
  const bySeverity = countBySeverity(findings);
  const healthScore = computeHealthScore(findings);
  const flowsCovered = buildFlowCoverage(state.plan, findings, targetUrl);
  const findingsByArea = groupFindingsByArea(bugFindings);
  const infoByArea = groupFindingsByArea(infoFindings);
  const templatedSummary = buildExecutiveSummary(
    state,
    bySeverity,
    bugFindings.length,
    flowsCovered.length,
    healthScore,
  );
  // Same pattern: the templated summary is always computed and is the guaranteed fallback;
  // the AI version only replaces it if it comes back and passes basic sanity bounds.
  const aiSummary = await summarizeWithAI(
    bugFindings,
    bySeverity,
    healthScore,
    state.classification?.siteType,
    targetUrl,
  ).catch(() => null);
  const executiveSummary = aiSummary ?? templatedSummary;
  const recommendedNextSteps = buildRecommendedNextSteps(bugFindings, bySeverity);
  const date = state.updatedAt || state.createdAt || new Date().toISOString();
  const areas = state.config.areas.join(', ') || 'n/a';

  const markdown = [
    '# Exploratory QA Report',
    '',
    executiveSummary,
    '',
    buildOverviewMarkdown(state, flowsCovered, bugFindings),
    buildFlowsMarkdown(flowsCovered),
    buildSiteKnowledgeMarkdown(state),
    buildApplicationMapMarkdown(state),
    buildPageCoverageMarkdown(state),
    buildActionInventoryMarkdown(state),
    buildEnvironmentMatrixMarkdown(state),
    buildAccessMapMarkdown(state),
    buildFindingDiffMarkdown(state),
    buildFindingsMarkdown(findingsByArea, bySeverity),
    buildInfoNotesMarkdown(infoByArea),
    `## ${infoByArea.length > 0 ? '5' : '4'}. Recommended Next Steps`,
    '',
    ...recommendedNextSteps.map((s, i) => `${i + 1}. ${s}`),
    '',
  ].join('\n');

  const displayDate = new Date(date).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const host = (() => {
    try {
      return new URL(state.config.targetUrl).hostname;
    } catch {
      return state.config.targetUrl;
    }
  })();

  const journeys = state.classification?.inferredJourneys?.slice(0, 5) ?? [];
  const authLabel =
    state.authProbe?.requiresAuth === false
      ? 'No login required'
      : state.authProbe?.suggestedMethod
        ? `Auth: ${state.authProbe.suggestedMethod}`
        : state.config.credentials?.type && state.config.credentials.type !== 'none'
          ? `Auth: ${state.config.credentials.type}`
          : 'Auth: not probed';

  const overviewRows = [
    ['Target', state.config.targetUrl],
    ['Status', state.status],
    ['Depth', state.config.depth],
    ['Areas selected', areas],
    ['Tasks completed', `${state.progress.completedTasks} / ${state.progress.totalTasks}`],
    ['Flows exercised', String(flowsCovered.length)],
    ['Findings', String(bugFindings.length)],
    [
      'Site type',
      state.classification
        ? `${state.classification.siteType} (${Math.round(state.classification.confidence * 100)}%)`
        : 'not classified',
    ],
    ['Inferred journeys', journeys.length ? journeys.join(', ') : '—'],
    ['Authentication', authLabel],
    ['API endpoints discovered', String(state.discoveredApiEndpoints?.length ?? 0)],
    ['Date', displayDate],
  ]
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td>${k === 'Target' ? `<a href="${escapeHtml(String(v))}">${escapeHtml(String(v))}</a>` : escapeHtml(String(v))}</td></tr>`,
    )
    .join('\n');

  const siteTypeLabel = state.classification
    ? `${state.classification.siteType} (${Math.round(state.classification.confidence * 100)}%)`
    : 'Not classified';

  const risk = overallRisk(bySeverity, bugFindings.length);

  const flowsByArea = groupFlowsByArea(flowsCovered);
  let flowsHtml = '<p class="empty">No plan tasks were recorded for this session.</p>';
  if (flowsCovered.length > 0) {
    const sections: string[] = [];
    for (const [area, rows] of flowsByArea) {
      const body = rows
        .map((r) => {
          const steps =
            r.steps.length > 0
              ? `<ol class="steps flow-steps">${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
              : '<p class="muted"><em>(no steps recorded)</em></p>';
          return `<tr>
          <td>
            <div class="flow-name">${escapeHtml(r.title)}</div>
            <div class="muted small">${escapeHtml(r.flowClass)}</div>
          </td>
          <td>
            <div>${escapeHtml(r.description || '—')}</div>
            <div class="block" style="margin-top:0.5rem"><span class="label">Steps to reproduce</span>${steps}</div>
          </td>
          <td class="num">${r.findingsCount}</td>
        </tr>`;
        })
        .join('\n');
      sections.push(`
        <div class="table-block">
          <div class="table-block-title">${escapeHtml(area)} <span class="muted">· ${rows.length} flows</span></div>
          <table class="data-table">
            <thead><tr><th style="width:28%">Flow</th><th>Scope &amp; steps</th><th style="width:12%">Findings</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`);
    }
    flowsHtml = sections.join('\n');
  }

  const areaSummaryHtml =
    findingsByArea.length === 0
      ? ''
      : `<table class="data-table">
        <thead><tr><th>Area</th><th style="width:12%">Count</th><th>Severity breakdown</th></tr></thead>
        <tbody>
          ${findingsByArea
            .map(
              (g) => `<tr>
              <td>${escapeHtml(g.area)}</td>
              <td class="num">${g.count}</td>
              <td>${escapeHtml(formatSeverityInline(g.bySeverity))}</td>
            </tr>`,
            )
            .join('\n')}
        </tbody>
      </table>`;

  let findingIdx = 0;
  const findingsHtml =
    findingsByArea.length === 0
      ? '<p class="empty">No findings were recorded during this exploration.</p>'
      : findingsByArea
          .map((g) => {
            const cards = g.findings
              .map((f) => {
                const html = formatFindingHtml(f, findingIdx);
                findingIdx += 1;
                return html;
              })
              .join('\n');
            return `
            <div class="area-group">
              <div class="area-group-head">
                <h3>${escapeHtml(g.area)}</h3>
                <span class="count-chip">${g.count}</span>
                <span class="muted small">${escapeHtml(formatSeverityInline(g.bySeverity))}</span>
              </div>
              ${cards}
            </div>`;
          })
          .join('\n');

  // Info-severity items get the same two-part treatment (area summary + detail cards) as
  // bug findings above, just in their own section with their own N- prefixed ids — reusing
  // formatFindingHtml keeps the visual language consistent while id/section placement makes
  // clear these aren't part of the bug list.
  const infoAreaSummaryHtml =
    infoByArea.length === 0
      ? ''
      : `<table class="data-table">
        <thead><tr><th>Area</th><th style="width:12%">Count</th></tr></thead>
        <tbody>
          ${infoByArea
            .map((g) => `<tr><td>${escapeHtml(g.area)}</td><td class="num">${g.count}</td></tr>`)
            .join('\n')}
        </tbody>
      </table>`;

  let infoIdx = 0;
  const infoNotesHtml =
    infoByArea.length === 0
      ? ''
      : infoByArea
          .map((g) => {
            const cards = g.findings
              .map((f) => {
                const html = formatFindingHtml(f, infoIdx, 'N');
                infoIdx += 1;
                return html;
              })
              .join('\n');
            return `
            <div class="area-group">
              <div class="area-group-head">
                <h3>${escapeHtml(g.area)}</h3>
                <span class="count-chip">${g.count}</span>
              </div>
              ${cards}
            </div>`;
          })
          .join('\n');

  const nextStepsHtml = recommendedNextSteps
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join('\n');

  const pageCoverageHtml = (() => {
    const discovered = state.discoveredRoutes ?? [];
    const visited = new Set(state.visitedRoutes ?? []);
    if (discovered.length === 0) return '';
    const notVisited = discovered.filter((r) => !visited.has(r));
    const visitedCount = discovered.length - notVisited.length;
    const notVisitedList =
      notVisited.length > 0
        ? `<div class="table-block-title">Not visited (${notVisited.length})</div>
           <ul>${notVisited.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : '<p class="muted">All discovered routes were visited.</p>';
    return `<p class="muted" style="margin:0 0 0.75rem">
        <strong>${visitedCount}/${discovered.length}</strong> routes discovered on the landing page were actually visited during this session.
      </p>
      ${notVisitedList}`;
  })();

  const actionInventoryHtml = (() => {
    const inv = state.actionInventory;
    if (!inv || inv.totalFound === 0) return '';
    const rows = Object.entries(inv.byResult)
      .map(([result, count]) => `<tr><td>${escapeHtml(result)}</td><td>${count}</td></tr>`)
      .join('');
    return `<p class="muted" style="margin:0 0 0.75rem">
        Found <strong>${inv.totalFound}</strong> distinct action element(s) (buttons, icon-buttons,
        menu items, tabs) — tested <strong>${inv.totalTested}</strong>, skipped
        <strong>${inv.totalSkippedRisky}</strong> as risky (delete/pay/send-style actions).
      </p>
      <table class="overview-table"><thead><tr><th>Outcome</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`;
  })();

  const findingDiffHtml = (() => {
    const diff = state.findingDiff;
    if (!diff) return '';
    const list = (title: string, items: string[]) =>
      items.length === 0
        ? ''
        : `<div class="table-block-title">${escapeHtml(title)} (${items.length})</div>
           <ul>${items.slice(0, 20).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    return `<p class="muted" style="margin:0 0 0.75rem">
        Compared against the previous completed run against this target${diff.previousSessionId ? ` (session <code>${escapeHtml(diff.previousSessionId.slice(0, 8))}</code>)` : ''}.
      </p>
      <div class="two-col">
        <div>${list('New', diff.newFindings)}</div>
        <div>${list('Fixed', diff.fixedFindings)}</div>
      </div>
      ${list('Recurring', diff.recurringFindings)}`;
  })();

  // The three sections below have a markdown-only equivalent (buildApplicationMapMarkdown /
  // buildEnvironmentMatrixMarkdown / buildAccessMapMarkdown) — mirrored here rather than
  // shared because this whole HTML template independently reimplements every section already
  // (see pageCoverageHtml/actionInventoryHtml/findingDiffHtml above, none of which call their
  // markdown counterparts either). Missing an HTML mirror here means these sections would
  // exist in the downloaded .md report but be genuinely invisible in the HTML report and the
  // web app's own rendering of it — confirmed as a real gap, not hypothetical.
  // Rendered as preformatted text rather than converted to HTML — this codebase has no
  // markdown-to-HTML renderer anywhere else (executiveSummary is deliberately plain prose to
  // avoid needing one), and writing a one-off parser just for this single field isn't worth
  // the edge-case risk for a first pass.
  const siteKnowledgeHtml = state.siteKnowledge
    ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:0.9rem;line-height:1.6">${escapeHtml(state.siteKnowledge)}</pre>`
    : '';

  const applicationMapHtml = (() => {
    const routes = state.discoveredRoutes ?? [];
    if (routes.length === 0) return '';
    const groups = new Map<string, string[]>();
    for (const route of routes) {
      let path: string;
      try {
        path = new URL(route).pathname;
      } catch {
        path = route;
      }
      const segment = path.split('/').filter(Boolean)[0] ?? '';
      const key = segment || '(root)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(path);
    }
    const items = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([segment, paths]) => `<li><strong>/${escapeHtml(segment)}</strong>
          <ul>${[...new Set(paths)].sort().map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </li>`,
      )
      .join('');
    return `<p class="muted" style="margin:0 0 0.75rem">Discovered routes grouped by top-level section:</p><ul>${items}</ul>`;
  })();

  const environmentMatrixHtml = (() => {
    const checks = state.environmentChecks ?? [];
    if (checks.length === 0) return '';
    const pages = [...new Set(checks.map((c) => c.pageUrl))];
    const browserEnvs: string[] = [];
    const deviceEnvs: string[] = [];
    for (const c of checks) {
      const bucket = c.kind === 'browser' ? browserEnvs : deviceEnvs;
      if (!bucket.includes(c.environment)) bucket.push(c.environment);
    }
    browserEnvs.sort((a, b) => (a === 'Chromium' ? -1 : b === 'Chromium' ? 1 : 0));
    const environments = [...browserEnvs, ...deviceEnvs];
    const byPageEnv = new Map<string, EnvironmentCheck>();
    for (const c of checks) byPageEnv.set(`${c.pageUrl}\u0000${c.environment}`, c);

    const notes: string[] = [];
    const rows = pages
      .map((pageUrl) => {
        const shortUrl = shortenPageUrl(pageUrl);
        const cells = environments
          .map((env) => {
            const c = byPageEnv.get(`${pageUrl}\u0000${env}`);
            if (!c) return '<td class="num">—</td>';
            if (c.ok) return '<td class="num">✓</td>';
            if (c.note) notes.push(`<li><strong>${escapeHtml(shortUrl)}</strong> × ${escapeHtml(env)}: ${escapeHtml(c.note)}</li>`);
            return '<td class="num">✗</td>';
          })
          .join('');
        return `<tr><td>${escapeHtml(shortUrl)}</td>${cells}</tr>`;
      })
      .join('');

    return `<p class="muted" style="margin:0 0 0.75rem">Every page × browser/device combination actually checked this session, and whether it matched the baseline.</p>
      <table class="data-table"><thead><tr><th>Page</th>${environments.map((e) => `<th>${escapeHtml(e)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
      ${notes.length > 0 ? `<div class="table-block-title" style="margin-top:0.75rem">✗ details</div><ul>${notes.join('')}</ul>` : ''}`;
  })();

  const accessMapHtml = (() => {
    const entries: AccessMapEntry[] = state.accessMap ?? [];
    if (entries.length === 0) return '';
    const rows = entries
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.feature)}</td><td class="num">✗</td><td class="num">${e.directlyReachable ? '✓' : '✗'}</td><td>${escapeHtml(e.note ?? '')}</td></tr>`,
      )
      .join('');
    return `<p class="muted" style="margin:0 0 0.75rem">UI-hidden links checked for direct reachability under the current session's authenticated role. Not a cross-role comparison — see note below.</p>
      <table class="data-table"><thead><tr><th>Feature/Link</th><th>Visible in UI</th><th>Directly Reachable</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="muted small" style="margin-top:0.5rem">A true multi-role (Admin vs. Manager vs. User) access matrix would require multiple real credential sets and multiple real logins, which this session's single-login architecture doesn't support without added risk to a live account.</p>`;
  })();

  const severityBars = SEVERITY_ORDER.map((sev) => {
    const n = bySeverity[sev];
    const pct = findings.length ? Math.round((n / findings.length) * 100) : 0;
    return `<div class="sev-row">
      <span class="sev-name">${sev}</span>
      <div class="sev-track"><div class="sev-fill ${sev}" style="width:${pct}%"></div></div>
      <span class="sev-count">${n}</span>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QA Report — ${escapeHtml(host)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --ink: #0f172a;
      --body: #334155;
      --muted: #64748b;
      --line: #e2e8f0;
      --soft: #f8fafc;
      --card: #ffffff;
      --navy: #0b1f33;
      --navy-2: #14324d;
      --link: #0f4c81;
      --critical: #b91c1c;
      --high: #c2410c;
      --medium: #a16207;
      --low: #1d4ed8;
      --info: #475569;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
      color: var(--body);
      background: #eef2f6;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      /* Systemic fix, not a one-off: findings routinely contain long unbroken strings (a
         full query-string URL, a concatenated selector list) that a browser otherwise treats
         as unbreakable, whose full-string width becomes the min-content size of whatever
         grid/flex column holds it — silently blowing that column, and the whole page, past
         the viewport. overflow-wrap is inherited, so setting it once here protects every
         current and future container in this report, rather than patching each layout only
         after a long enough string happens to land in it (as already happened three times:
         the evidence list, the finding cards, and the New/Fixed regression columns). */
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .doc {
      max-width: 900px;
      margin: 2rem auto 3rem;
      background: var(--card);
      border: 1px solid var(--line);
      box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
    }
    .cover {
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy-2) 100%);
      color: #f8fafc;
      padding: 2.25rem 2.5rem 2rem;
    }
    .cover-top {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
      margin-bottom: 1.75rem;
      font-size: 0.78rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.85;
    }
    .cover h1 {
      font-family: "IBM Plex Serif", Georgia, serif;
      font-size: clamp(1.6rem, 3vw, 2rem);
      font-weight: 700;
      color: #fff;
      margin: 0 0 0.4rem;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .cover .subtitle {
      margin: 0 0 1.5rem;
      font-size: 0.95rem;
      opacity: 0.9;
    }
    .cover a { color: #93c5fd; word-break: break-all; }
    .cover-meta {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.75rem;
      border-top: 1px solid rgba(255,255,255,0.15);
      padding-top: 1.15rem;
    }
    @media (max-width: 700px) {
      .cover-meta { grid-template-columns: 1fr 1fr; }
      .cover { padding: 1.5rem; }
    }
    .cover-meta dt {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.65;
      margin: 0 0 0.2rem;
    }
    .cover-meta dd {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 600;
      color: #fff;
    }
    .risk-badge {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .risk-critical { background: #fecaca; color: #7f1d1d; }
    .risk-high { background: #fed7aa; color: #7c2d12; }
    .risk-medium { background: #fde68a; color: #713f12; }
    .risk-low { background: #bfdbfe; color: #1e3a8a; }
    .risk-clear { background: #bbf7d0; color: #14532d; }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      background: var(--soft);
      border-bottom: 1px solid var(--line);
    }
    .toolbar button {
      font: inherit;
      font-size: 0.82rem;
      font-weight: 600;
      padding: 0.45rem 0.85rem;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 4px;
      cursor: pointer;
    }
    .toolbar button.primary {
      background: var(--navy);
      color: #fff;
      border-color: var(--navy);
    }
    .body { padding: 1.75rem 2.5rem 2.5rem; }
    @media (max-width: 700px) { .body { padding: 1.25rem 1.25rem 2rem; } }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.75rem;
      margin-bottom: 1.75rem;
    }
    @media (max-width: 700px) { .kpi-grid { grid-template-columns: 1fr 1fr; } }
    .kpi {
      border: 1px solid var(--line);
      background: var(--soft);
      padding: 0.9rem 1rem;
    }
    .kpi .v {
      font-family: "IBM Plex Serif", Georgia, serif;
      font-size: 1.55rem;
      font-weight: 700;
      color: var(--ink);
      line-height: 1;
      margin-bottom: 0.3rem;
    }
    .kpi .l {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    h2 {
      font-family: "IBM Plex Serif", Georgia, serif;
      font-size: 1.15rem;
      color: var(--ink);
      margin: 0 0 0.85rem;
      padding-bottom: 0.45rem;
      border-bottom: 2px solid var(--navy);
      display: inline-block;
      min-width: 40%;
    }
    section.sec { margin-bottom: 2rem; }
    .summary-text {
      margin: 0 0 1rem;
      color: var(--ink);
      font-size: 0.98rem;
    }
    .toc {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.25rem;
      margin: 0 0 1.75rem;
      padding: 0.85rem 1rem;
      list-style: none;
      background: var(--soft);
      border: 1px solid var(--line);
      font-size: 0.88rem;
    }
    .toc a { color: var(--link); text-decoration: none; font-weight: 600; }
    .toc a:hover { text-decoration: underline; }
    .two-col {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 1.25rem;
      margin-top: 0.75rem;
    }
    /* Grid items default to min-width:auto — a single long unbroken string (a finding title
       carrying a full query-string URL, common in rate-limit/API findings) can otherwise
       force a column wider than its track and overflow the page, the same issue fixed
       elsewhere for the live app's chat/findings columns. */
    .two-col > div { min-width: 0; }
    .two-col li { overflow-wrap: break-word; word-break: break-word; }
    @media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }
    .overview-table, .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    .overview-table th {
      text-align: left;
      width: 36%;
      color: var(--muted);
      font-weight: 600;
      padding: 0.5rem 0.75rem 0.5rem 0;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .overview-table td {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--line);
      color: var(--ink);
      word-break: break-word;
    }
    .overview-table a { color: var(--link); }
    .data-table th, .data-table td {
      text-align: left;
      padding: 0.55rem 0.65rem;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .data-table thead th {
      background: var(--soft);
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 700;
      border-top: 1px solid var(--line);
    }
    .data-table .num { text-align: center; font-weight: 600; color: var(--ink); }
    .flow-name { font-weight: 600; color: var(--ink); }
    .table-block { margin: 1rem 0 1.25rem; }
    .table-block-title {
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 0.4rem;
      text-transform: capitalize;
    }
    .sev-row {
      display: grid;
      grid-template-columns: 4.5rem 1fr 2rem;
      gap: 0.5rem;
      align-items: center;
      margin: 0.4rem 0;
      font-size: 0.82rem;
      text-transform: capitalize;
    }
    .sev-name { color: var(--muted); font-weight: 600; }
    .sev-track {
      height: 8px;
      background: #e2e8f0;
      border-radius: 2px;
      overflow: hidden;
    }
    .sev-fill { height: 100%; border-radius: 2px; }
    .sev-fill.critical { background: var(--critical); }
    .sev-fill.high { background: var(--high); }
    .sev-fill.medium { background: var(--medium); }
    .sev-fill.low { background: var(--low); }
    .sev-fill.info { background: var(--info); }
    .sev-count { text-align: right; font-weight: 700; color: var(--ink); }
    .area-group { margin: 1.25rem 0; }
    .area-group-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.55rem;
      margin-bottom: 0.75rem;
    }
    .area-group-head h3 {
      margin: 0;
      font-size: 0.95rem;
      color: var(--ink);
      font-weight: 700;
    }
    .count-chip {
      background: var(--navy);
      color: #fff;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 3px;
    }
    .finding {
      border: 1px solid var(--line);
      border-left: 4px solid var(--line);
      padding: 1rem 1.15rem;
      margin: 0 0 0.75rem;
      background: #fff;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .finding[data-severity="critical"] { border-left-color: var(--critical); }
    .finding[data-severity="high"] { border-left-color: var(--high); }
    .finding[data-severity="medium"] { border-left-color: var(--medium); }
    .finding[data-severity="low"] { border-left-color: var(--low); }
    .finding[data-severity="info"] { border-left-color: var(--info); }
    .finding-head {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      align-items: center;
      margin-bottom: 0.45rem;
    }
    .finding-id {
      font-family: ui-monospace, monospace;
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--muted);
    }
    .sev-badge {
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.18rem 0.45rem;
      border-radius: 3px;
      color: #fff;
    }
    .sev-badge.critical { background: var(--critical); }
    .sev-badge.high { background: var(--high); }
    .sev-badge.medium { background: var(--medium); }
    .sev-badge.low { background: var(--low); }
    .sev-badge.info { background: var(--info); }
    .area-chip {
      font-size: 0.72rem;
      color: var(--muted);
      background: var(--soft);
      border: 1px solid var(--line);
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
    }
    .confidence-badge {
      font-size: 0.68rem;
      font-weight: 600;
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
      border: 1px solid;
    }
    .confidence-badge.verified {
      color: #1a7f37;
      background: #eaf7ee;
      border-color: #b7e3c3;
    }
    .confidence-badge.heuristic {
      color: #9a6700;
      background: #fff8e6;
      border-color: #f0dca0;
    }
    .confidence-note {
      margin: 0 0 0.75rem;
      font-size: 0.82rem;
      color: var(--muted);
      background: var(--soft);
      border-left: 3px solid var(--line);
      padding: 0.5rem 0.75rem;
      border-radius: 0 4px 4px 0;
    }
    .confidence-note .label { display: block; margin-bottom: 0.2rem; }
    .finding h4 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
      color: var(--ink);
      font-weight: 600;
    }
    .label {
      display: block;
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .block { margin-bottom: 0.75rem; }
    .pre { margin: 0 0 0.75rem; }
    .steps, .evidence { margin: 0.15rem 0 0; padding-left: 1.15rem; }
    .evidence-shots { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.25rem; }
    .evidence-shot {
      max-width: 240px;
      max-height: 160px;
      object-fit: cover;
      border: 1px solid var(--line);
      border-radius: 6px;
      display: block;
    }
    .evidence-file {
      font-size: 0.8rem;
      color: var(--muted);
      font-family: monospace;
    }
    .ea-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.6rem;
      margin-bottom: 0.75rem;
    }
    @media (max-width: 640px) { .ea-grid { grid-template-columns: 1fr; } }
    .ea {
      padding: 0.65rem 0.75rem;
      border: 1px solid var(--line);
      background: var(--soft);
    }
    .ea.expected { border-left: 3px solid #15803d; }
    .ea.actual { border-left: 3px solid #b45309; }
    .ea-text { margin: 0; font-size: 0.9rem; color: var(--ink); }
    .finding-list { margin: 0.3rem 0 0 1.1rem; padding: 0; }
    .finding-list li { margin: 0.1rem 0; }
    .finding-foot {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: var(--muted);
      padding-top: 0.55rem;
      border-top: 1px solid var(--line);
    }
    .next-steps { margin: 0; padding-left: 1.2rem; color: var(--ink); }
    .next-steps li { margin: 0.4rem 0; }
    .muted, .empty { color: var(--muted); }
    .small { font-size: 0.75rem; }
    .doc-footer {
      border-top: 1px solid var(--line);
      padding: 1rem 2.5rem;
      font-size: 0.75rem;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      background: var(--soft);
    }
    @media print {
      body { background: #fff; }
      .doc { margin: 0; border: none; box-shadow: none; max-width: none; }
      .toolbar { display: none !important; }
      .cover { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="doc">
    <header class="cover">
      <div class="cover-top">
        <span>Exploratory Quality Assurance</span>
        <span>Session ${escapeHtml(state.id.slice(0, 8))}</span>
      </div>
      <h1>${escapeHtml(host)}</h1>
      <p class="subtitle"><a href="${escapeHtml(state.config.targetUrl)}">${escapeHtml(state.config.targetUrl)}</a></p>
      <dl class="cover-meta">
        <div><dt>Report date</dt><dd>${escapeHtml(displayDate)}</dd></div>
        <div><dt>Depth</dt><dd>${escapeHtml(state.config.depth)}</dd></div>
        <div><dt>Site type</dt><dd>${escapeHtml(siteTypeLabel)}</dd></div>
        <div><dt>Overall risk</dt><dd><span class="risk-badge ${risk.className}">${risk.label}</span></dd></div>
      </dl>
    </header>

    <div class="toolbar no-print">
      <button type="button" class="primary" onclick="window.print()">Print / Save as PDF</button>
    </div>

    <div class="body">
      <div class="kpi-grid">
        <div class="kpi"><div class="v">${flowsCovered.length}</div><div class="l">Flows tested</div></div>
        <div class="kpi"><div class="v">${state.progress.completedTasks}/${state.progress.totalTasks}</div><div class="l">Tasks completed</div></div>
        <div class="kpi"><div class="v">${bugFindings.length}</div><div class="l">Findings</div></div>
        <div class="kpi"><div class="v">${bySeverity.critical + bySeverity.high}</div><div class="l">Critical + High</div></div>
      </div>

      <ul class="toc">
        <li><a href="#overview">1. Overview</a></li>
        <li><a href="#flows">2. Flows tested</a></li>
        ${siteKnowledgeHtml ? '<li><a href="#site-knowledge">Application Knowledge Base</a></li>' : ''}
        ${applicationMapHtml ? '<li><a href="#application-map">Application Map</a></li>' : ''}
        ${pageCoverageHtml ? '<li><a href="#page-coverage">Page Coverage</a></li>' : ''}
        ${actionInventoryHtml ? '<li><a href="#action-inventory">Action Inventory</a></li>' : ''}
        ${environmentMatrixHtml ? '<li><a href="#environment-matrix">Environment Comparison</a></li>' : ''}
        ${accessMapHtml ? '<li><a href="#access-map">Access Map</a></li>' : ''}
        ${findingDiffHtml ? '<li><a href="#regression">Regression vs Previous Run</a></li>' : ''}
        <li><a href="#findings">3. Findings</a></li>
        ${infoNotesHtml ? `<li><a href="#info-notes">4. Additional Notes</a></li>` : ''}
        <li><a href="#next-steps">${infoNotesHtml ? '5' : '4'}. Recommendations</a></li>
      </ul>

      <section class="sec" id="overview">
        <h2>1. Overview</h2>
        <p class="summary-text">${escapeHtml(executiveSummary)}</p>
        <div class="two-col">
          <table class="overview-table">${overviewRows}</table>
          <div>
            <div class="table-block-title">Severity distribution</div>
            ${severityBars}
          </div>
        </div>
      </section>

      <section class="sec" id="flows">
        <h2>2. Flows Tested</h2>
        <p class="muted" style="margin:0 0 0.75rem">Functional journeys and UI checks exercised in this session, grouped by exploration area.</p>
        ${flowsHtml}
      </section>

      ${siteKnowledgeHtml ? `<section class="sec" id="site-knowledge">
        <h2>Application Knowledge Base</h2>
        ${siteKnowledgeHtml}
      </section>` : ''}

      ${applicationMapHtml ? `<section class="sec" id="application-map">
        <h2>Application Map</h2>
        ${applicationMapHtml}
      </section>` : ''}

      ${pageCoverageHtml ? `<section class="sec" id="page-coverage">
        <h2>Page Coverage</h2>
        ${pageCoverageHtml}
      </section>` : ''}

      ${actionInventoryHtml ? `<section class="sec" id="action-inventory">
        <h2>Action Inventory</h2>
        ${actionInventoryHtml}
      </section>` : ''}

      ${environmentMatrixHtml ? `<section class="sec" id="environment-matrix">
        <h2>Environment Comparison</h2>
        ${environmentMatrixHtml}
      </section>` : ''}

      ${accessMapHtml ? `<section class="sec" id="access-map">
        <h2>Access Map</h2>
        ${accessMapHtml}
      </section>` : ''}

      ${findingDiffHtml ? `<section class="sec" id="regression">
        <h2>Regression vs Previous Run</h2>
        ${findingDiffHtml}
      </section>` : ''}

      <section class="sec" id="findings">
        <h2>3. Findings</h2>
        ${areaSummaryHtml ? `<div style="margin:0.75rem 0 1.25rem">${areaSummaryHtml}</div>` : ''}
        ${findingsHtml}
      </section>

      ${infoNotesHtml ? `<section class="sec" id="info-notes">
        <h2>4. Additional Notes <span class="muted small">(${infoFindings.length})</span></h2>
        <p class="muted" style="margin:0 0 0.75rem">Not defects — informational observations (discovered endpoints, coverage summaries, confirmation checks) that may be useful context for future exploration.</p>
        ${infoAreaSummaryHtml ? `<div style="margin:0.75rem 0 1.25rem">${infoAreaSummaryHtml}</div>` : ''}
        ${infoNotesHtml}
      </section>` : ''}

      <section class="sec" id="next-steps">
        <h2>${infoNotesHtml ? '5' : '4'}. Recommendations</h2>
        <ol class="next-steps">${nextStepsHtml}</ol>
      </section>
    </div>

    <footer class="doc-footer">
      <span>Generated by Generic Exploratory QA Agent</span>
      <span>Areas: ${escapeHtml(areas)} · Status: ${escapeHtml(state.status)}</span>
    </footer>
  </div>
</body>
</html>
`;

  return {
    markdown,
    html,
    summary: {
      total: bugFindings.length,
      bySeverity,
      healthScore,
      executiveSummary,
      recommendedNextSteps,
      flowsCovered,
      findingsByArea,
      findings: bugFindings,
      infoFindings,
      infoByArea,
    },
  };
}
