import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrdCoverageSummary, SessionState } from '@qa/shared';

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
  const lines: string[] = [
    `# Exploration Report`,
    ``,
    `**Session:** ${state.id}`,
    `**Target:** ${state.config.targetUrl}`,
    `**Status:** ${state.status}`,
    `**Findings:** ${state.findings.length}`,
    `**Completed:** ${state.updatedAt}`,
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
        lines.push(`- **Steps:**`);
        for (const s of f.steps) lines.push(`  1. ${s}`);
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
