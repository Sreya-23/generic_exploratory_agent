import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeHealthScore, type PrdCoverageSummary, type SessionState } from '@qa/shared';
import { generateSessionReport, type SessionReport } from './generate-report.js';

export { generateSessionReport, dedupeFindings } from './generate-report.js';
export type {
  SessionReport,
  SeverityCounts,
  FlowCoverageRow,
  AreaFindingGroup,
} from './generate-report.js';

export async function ensureSessionDir(sessionsDir: string, sessionId: string): Promise<string> {
  const dir = join(sessionsDir, sessionId);
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  await mkdir(join(dir, 'har'), { recursive: true });
  await mkdir(join(dir, 'logs'), { recursive: true });
  return dir;
}

export async function saveSessionState(
  sessionsDir: string,
  state: SessionState,
): Promise<void> {
  const dir = await ensureSessionDir(sessionsDir, state.id);
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  await writeFile(join(dir, 'config.json'), JSON.stringify(state.config, null, 2));
  if (state.plan) {
    await writeFile(join(dir, 'plan.json'), JSON.stringify(state.plan, null, 2));
  }
  await writeFile(join(dir, 'findings.json'), JSON.stringify(state.findings, null, 2));
  if (state.prdCoverage) {
    await writeFile(join(dir, 'prd-coverage.md'), state.prdCoverage.markdown);
    await writeFile(join(dir, 'prd-coverage.json'), JSON.stringify(state.prdCoverage, null, 2));
  }
}

/** Full session report (Markdown) including optional PRD coverage */
export function generateSessionReportMarkdown(state: SessionState): string {
  const health = computeHealthScore(state.findings);
  const lines: string[] = [
    `# Exploration Report`,
    ``,
    `**Session:** ${state.id}`,
    `**Target:** ${state.config.targetUrl}`,
    `**Status:** ${state.status}`,
    `**Findings:** ${state.findings.length}`,
    `**Completed:** ${state.updatedAt}`,
    ``,
    `## Health Score: ${health.grade} (${health.score}/100)`,
    ``,
    health.summary,
    ``,
  ];

  if (state.config.prdPath) {
    lines.push(`**Mode:** PRD-only (generic matrix skipped)`);
    lines.push(`**PRD:** ${state.config.prdFilename ?? state.config.prdPath}`);
    lines.push('');
  }

  if (state.prdCoverage) {
    lines.push(state.prdCoverage.markdown);
    lines.push('');
  }

  lines.push(`## Findings (${state.findings.length})`);
  if (state.findings.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    for (const f of state.findings) {
      lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
      lines.push(`- **Area:** ${f.area}`);
      if (f.requirementId) lines.push(`- **Requirement:** ${f.requirementId}`);
      if (f.taskId) lines.push(`- **Task:** ${f.taskId}`);
      if (f.quarantineReason) lines.push(`- **Quarantined:** ${f.quarantineReason}`);
      if (f.fingerprint) lines.push(`- **Fingerprint:** \`${f.fingerprint}\``);
      lines.push(`- **Expected:** ${f.expected}`);
      lines.push(`- **Actual:** ${f.actual}`);
      if (f.steps.length) {
        lines.push(`- **Steps to reproduce:**`);
        for (const [i, s] of f.steps.entries()) lines.push(`  ${i + 1}. ${s}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function chatSummaryFromCoverage(coverage: PrdCoverageSummary): string {
  const diff = coverage.findingDiff;
  return [
    `📋 **PRD coverage summary**`,
    ``,
    `- Features extracted: **${coverage.featuresExtracted.length}**`,
    `- Variants passed: **${coverage.passedCount}**`,
    `- Variants failed: **${coverage.failedCount}**`,
    `- Gaps (no UI): **${coverage.gaps.length}**`,
    `- Blocked: **${coverage.blocked.length}**`,
    diff
      ? `- Finding diff: **+${diff.newFindings.length} new** / **-${diff.fixedFindings.length} fixed** / **${diff.recurringFindings.length} recurring**`
      : '',
    ``,
    coverage.gaps.length
      ? `**Gaps:**\n${coverage.gaps.slice(0, 8).map((g) => `- ${g}`).join('\n')}`
      : '',
    ``,
    `_Full coverage table is in the session report._`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build Markdown + HTML report from session findings and write to the session folder. */
export async function writeSessionReport(
  sessionsDir: string,
  state: SessionState,
): Promise<SessionReport> {
  const report = generateSessionReport(state);
  const dir = await ensureSessionDir(sessionsDir, state.id);
  await writeFile(join(dir, 'report.md'), report.markdown, 'utf8');
  await writeFile(join(dir, 'report.html'), report.html, 'utf8');
  await writeFile(
    join(dir, 'report-summary.json'),
    JSON.stringify(report.summary, null, 2),
    'utf8',
  );
  return report;
}
