import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, SessionState } from '@qa/shared';

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

function severityEmoji(severity: Finding['severity']): string {
  const map = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };
  return map[severity];
}

export function generateMarkdownReport(state: SessionState): string {
  const lines: string[] = [
    `# Exploratory QA Report`,
    ``,
    `**Session:** ${state.id}`,
    `**Target:** ${state.config.targetUrl}`,
    `**Depth:** ${state.config.depth}`,
    `**Areas:** ${state.config.areas.join(', ')}`,
    `**Status:** ${state.status}`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `- Total findings: ${state.findings.length}`,
    `- Critical: ${state.findings.filter((f) => f.severity === 'critical').length}`,
    `- High: ${state.findings.filter((f) => f.severity === 'high').length}`,
    `- Medium: ${state.findings.filter((f) => f.severity === 'medium').length}`,
    `- Low: ${state.findings.filter((f) => f.severity === 'low').length}`,
  ];

  if (state.config.context) {
    lines.push('', `**Context:** ${state.config.context}`);
  }

  lines.push('', `## Findings`, '');

  if (state.findings.length === 0) {
    lines.push('_No issues found during this session._');
  } else {
    for (const f of state.findings) {
      lines.push(
        `### ${severityEmoji(f.severity)} [${f.severity.toUpperCase()}] ${f.title}`,
        ``,
        `**Area:** ${f.area}`,
        f.preconditions ? `**Preconditions:** ${f.preconditions}` : '',
        `**Steps:**`,
        ...f.steps.map((s, i) => `${i + 1}. ${s}`),
        `**Expected:** ${f.expected}`,
        `**Actual:** ${f.actual}`,
        `**Repro rate:** ${f.reproRate}`,
        `**Automation candidate:** ${f.automationCandidate ? 'Yes' : 'No'}`,
        f.evidence.length > 0 ? `**Evidence:** ${f.evidence.join(', ')}` : '',
        '',
      );
    }
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

export function generateHtmlReport(state: SessionState): string {
  const md = generateMarkdownReport(state);
  const body = md
    .replace(/^### (.*)/gm, '<h3>$1</h3>')
    .replace(/^## (.*)/gm, '<h2>$1</h2>')
    .replace(/^# (.*)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Report - ${state.id}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1 { color: #1a1a2e; } h2 { color: #16213e; border-bottom: 1px solid #eee; padding-bottom: 0.5rem; }
    h3 { color: #0f3460; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export async function writeReports(
  sessionsDir: string,
  state: SessionState,
): Promise<void> {
  const dir = join(sessionsDir, state.id);
  await writeFile(join(dir, 'report.md'), generateMarkdownReport(state));
  await writeFile(join(dir, 'report.html'), generateHtmlReport(state));
  await writeFile(join(dir, 'findings.json'), JSON.stringify(state.findings, null, 2));
}
