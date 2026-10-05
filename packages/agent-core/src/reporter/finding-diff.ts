/**
 * Cross-session finding fingerprint diff — new / fixed / recurring.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, FindingFingerprintDiff } from '@qa/shared';

export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function fingerprintFinding(f: {
  area?: string;
  title: string;
  severity?: string;
}): string {
  return `${f.area ?? 'unknown'}|${normalizeFindingTitle(f.title)}`;
}

export function attachFingerprints<T extends { area: string; title: string; fingerprint?: string }>(
  findings: T[],
): T[] {
  return findings.map((f) => ({
    ...f,
    fingerprint: f.fingerprint ?? fingerprintFinding(f),
  }));
}

export function diffFindingFingerprints(
  current: Array<{ fingerprint?: string; title: string; severity: string; area?: string }>,
  previous: Array<{ fingerprint?: string; title: string; severity: string; area?: string }>,
  previousSessionId?: string,
): FindingFingerprintDiff {
  const cur = new Map(
    current
      .filter((f) => f.severity !== 'info')
      .map((f) => [f.fingerprint ?? fingerprintFinding(f), f.title]),
  );
  const prev = new Map(
    previous
      .filter((f) => f.severity !== 'info')
      .map((f) => [f.fingerprint ?? fingerprintFinding(f), f.title]),
  );

  const newFindings: string[] = [];
  const recurringFindings: string[] = [];
  const fixedFindings: string[] = [];

  for (const [fp, title] of cur) {
    if (prev.has(fp)) recurringFindings.push(title);
    else newFindings.push(title);
  }
  for (const [fp, title] of prev) {
    if (!cur.has(fp)) fixedFindings.push(title);
  }

  const lines = [
    `## Finding baseline diff`,
    previousSessionId ? `**Previous session:** \`${previousSessionId}\`` : '_No previous session for this target_',
    '',
    `| Change | Count |`,
    `|---|---|`,
    `| New | ${newFindings.length} |`,
    `| Fixed | ${fixedFindings.length} |`,
    `| Recurring | ${recurringFindings.length} |`,
    '',
  ];
  if (newFindings.length) {
    lines.push(`### New`);
    for (const t of newFindings.slice(0, 20)) lines.push(`- ${t}`);
    lines.push('');
  }
  if (fixedFindings.length) {
    lines.push(`### Fixed (were in previous, gone now)`);
    for (const t of fixedFindings.slice(0, 20)) lines.push(`- ${t}`);
    lines.push('');
  }
  if (recurringFindings.length) {
    lines.push(`### Recurring`);
    for (const t of recurringFindings.slice(0, 20)) lines.push(`- ${t}`);
    lines.push('');
  }

  return {
    previousSessionId,
    newFindings,
    fixedFindings,
    recurringFindings,
    markdown: lines.join('\n'),
  };
}

/** Find most recent completed session for the same targetUrl (excluding current). */
export async function loadPreviousSessionFindings(
  sessionsDir: string,
  targetUrl: string,
  currentSessionId: string,
): Promise<{ sessionId: string; findings: Finding[] } | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const candidates: Array<{ id: string; updatedAt: string }> = [];
  for (const id of entries) {
    if (id.startsWith('setup-') || id === currentSessionId) continue;
    try {
      const raw = await readFile(join(sessionsDir, id, 'state.json'), 'utf-8');
      const state = JSON.parse(raw) as {
        status?: string;
        updatedAt?: string;
        config?: { targetUrl?: string };
      };
      if (state.status !== 'completed') continue;
      if (state.config?.targetUrl !== targetUrl) continue;
      candidates.push({ id, updatedAt: state.updatedAt ?? '' });
    } catch {
      /* skip */
    }
  }

  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const best = candidates[0];
  if (!best) return null;

  try {
    const findings = JSON.parse(
      await readFile(join(sessionsDir, best.id, 'findings.json'), 'utf-8'),
    ) as Finding[];
    return { sessionId: best.id, findings: Array.isArray(findings) ? findings : [] };
  } catch {
    return null;
  }
}
