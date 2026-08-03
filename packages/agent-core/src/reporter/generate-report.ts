import type {
  ExplorationPlan,
  Finding,
  FlowTask,
  SessionState,
  Severity,
} from '@qa/shared';
import { FLOW_TITLES } from '@qa/shared';

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
    total: number;
    bySeverity: SeverityCounts;
    executiveSummary: string;
    recommendedNextSteps: string[];
    flowsCovered: FlowCoverageRow[];
    findingsByArea: AreaFindingGroup[];
    /** Findings with steps-to-reproduce always populated for report consumers */
    findings: Finding[];
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
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.area}|${f.title}|${f.actual}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function flowTitle(flowClass: string): string {
  return FLOW_TITLES[flowClass] ?? flowClass.replace(/-/g, ' ');
}

function findingMatchesTask(finding: Finding, task: FlowTask): boolean {
  const area = finding.area.toLowerCase();
  const title = finding.title.toLowerCase();
  const fc = task.flowClass.toLowerCase();
  return (
    area.includes(fc) ||
    area.includes(task.area) ||
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
): string {
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
  return `Explored ${state.config.targetUrl} at ${depth} depth (${tasks}).${siteClause}${flows} Recorded ${total} finding${total === 1 ? '' : 's'} (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium). ${risk}`;
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
  lines.push(`**Expected:** ${f.expected}`);
  lines.push(`**Actual:** ${f.actual}`);
  lines.push(`**Evidence:** ${f.evidence.length > 0 ? f.evidence.join(', ') : 'None attached'}`);
  lines.push(`**Repro rate:** ${f.reproRate}`);
  lines.push(`**Automation candidate:** ${f.automationCandidate ? 'Yes' : 'No'}`);
  lines.push('');
  return lines.join('\n');
}

function formatFindingHtml(f: Finding, index: number): string {
  const id = `F-${String(index + 1).padStart(3, '0')}`;
  const steps =
    f.steps.length > 0
      ? `<ol class="steps">${f.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
      : '<p class="muted"><em>(no steps recorded)</em></p>';
  const evidence =
    f.evidence.length > 0
      ? `<ul class="evidence">${f.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : '<p class="muted">None attached</p>';

  return `
<article class="finding" data-severity="${escapeHtml(f.severity)}">
  <header class="finding-head">
    <span class="finding-id">${id}</span>
    <span class="sev-badge ${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
    <span class="area-chip">${escapeHtml(f.area)}</span>
  </header>
  <h4>${escapeHtml(f.title)}</h4>
  ${f.preconditions ? `<p class="pre"><span class="label">Preconditions</span>${escapeHtml(f.preconditions)}</p>` : ''}
  <div class="block"><span class="label">Steps to reproduce</span>${steps}</div>
  <div class="ea-grid">
    <div class="ea expected"><span class="label">Expected</span><p>${escapeHtml(f.expected)}</p></div>
    <div class="ea actual"><span class="label">Actual</span><p>${escapeHtml(f.actual)}</p></div>
  </div>
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

function buildFindingsMarkdown(groups: AreaFindingGroup[], bySeverity: SeverityCounts): string {
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
    `| Info     | ${bySeverity.info} |`,
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

export function generateSessionReport(state: SessionState): SessionReport {
  const targetUrl = state.config.targetUrl;
  const findings = sortFindings(dedupeFindings(state.findings)).map((f) =>
    withReproSteps(f, targetUrl),
  );
  const bySeverity = countBySeverity(findings);
  const flowsCovered = buildFlowCoverage(state.plan, findings, targetUrl);
  const findingsByArea = groupFindingsByArea(findings);
  const executiveSummary = buildExecutiveSummary(
    state,
    bySeverity,
    findings.length,
    flowsCovered.length,
  );
  const recommendedNextSteps = buildRecommendedNextSteps(findings, bySeverity);
  const date = state.updatedAt || state.createdAt || new Date().toISOString();
  const areas = state.config.areas.join(', ') || 'n/a';

  const markdown = [
    '# Exploratory QA Report',
    '',
    executiveSummary,
    '',
    buildOverviewMarkdown(state, flowsCovered, findings),
    buildFlowsMarkdown(flowsCovered),
    buildFindingsMarkdown(findingsByArea, bySeverity),
    '## 4. Recommended Next Steps',
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
    ['Findings', String(findings.length)],
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

  const risk = overallRisk(bySeverity, findings.length);

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

  const nextStepsHtml = recommendedNextSteps
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join('\n');

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
    .ea p { margin: 0; font-size: 0.9rem; color: var(--ink); }
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
        <div class="kpi"><div class="v">${findings.length}</div><div class="l">Findings</div></div>
        <div class="kpi"><div class="v">${bySeverity.critical + bySeverity.high}</div><div class="l">Critical + High</div></div>
      </div>

      <ul class="toc">
        <li><a href="#overview">1. Overview</a></li>
        <li><a href="#flows">2. Flows tested</a></li>
        <li><a href="#findings">3. Findings</a></li>
        <li><a href="#next-steps">4. Recommendations</a></li>
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

      <section class="sec" id="findings">
        <h2>3. Findings</h2>
        ${areaSummaryHtml ? `<div style="margin:0.75rem 0 1.25rem">${areaSummaryHtml}</div>` : ''}
        ${findingsHtml}
      </section>

      <section class="sec" id="next-steps">
        <h2>4. Recommendations</h2>
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
      total: findings.length,
      bySeverity,
      executiveSummary,
      recommendedNextSteps,
      flowsCovered,
      findingsByArea,
      findings,
    },
  };
}
