import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeHealthScore, type SessionState } from '@qa/shared';
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
}

/** Full session report (Markdown) */
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

  lines.push(`## Findings (${state.findings.length})`);
  if (state.findings.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    for (const f of state.findings) {
      lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
      lines.push(`- **Area:** ${f.area}`);
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

/** Build Markdown + HTML report from session findings and write to the session folder. */
export async function writeSessionReport(
  sessionsDir: string,
  state: SessionState,
): Promise<SessionReport> {
  const report = await generateSessionReport(state);
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
