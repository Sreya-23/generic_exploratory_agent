// Raises this agent's own findings as real bug reports in QualityPilot (a separate app) via
// its purpose-built ingestion endpoint: POST /workspaces/{id}/projects/{id}/exploratory/
// submit-findings. That endpoint already existed there for exactly this use case — the only
// gap was it had no `screenshots` field (silently dropped evidence) and the UI never rendered
// one, both fixed directly in that project alongside this.
//
// Connection config (base URL, workspace/project ID, API key) is saved once via the setup UI,
// not re-entered per session — same reasoning as credentials-store.ts. QualityPilot's backend
// now has a dedicated long-lived API key for exactly this kind of server-to-server
// integration (EXPLORATORY_AGENT_API_KEY, checked in its own auth middleware before falling
// back to normal per-user Supabase session auth) — this is NOT a user login token, so it
// doesn't expire hourly like one would; it only needs re-entering if it's ever rotated.
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Finding, SessionState } from '@qa/shared';

export interface QualityPilotConfig {
  baseUrl: string;
  workspaceId: string;
  projectId: string;
  token: string;
}

function configPath(root: string): string {
  return join(root, 'qualitypilot-integration.json');
}

export async function loadQualityPilotConfig(root: string): Promise<QualityPilotConfig | null> {
  const path = configPath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.baseUrl && parsed.workspaceId && parsed.projectId && parsed.token) {
      return parsed as QualityPilotConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveQualityPilotConfig(root: string, config: QualityPilotConfig): Promise<void> {
  await writeFile(configPath(root), JSON.stringify(config, null, 2), 'utf-8');
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function screenshotToDataUri(path: string): string | null {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime || !existsSync(path)) return null;
  try {
    const buffer = readFileSync(path);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

const SEVERITY_MAP: Record<Finding['severity'], string | null> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  // 'info' findings are explicitly not defects (see generate-report.ts's bugFindings/
  // infoFindings split) — never offered for raising as a bug in the first place, but mapped
  // defensively here too in case a caller passes one anyway.
  info: null,
};

function findingToExploratoryInput(finding: Finding, targetUrl: string) {
  const descriptionParts = [
    `Expected: ${finding.expected}`,
    `Actual: ${finding.actual}`,
    finding.confidenceReason ? `Confidence note: ${finding.confidenceReason}` : '',
  ];
  const screenshots = (finding.evidence ?? [])
    .map(screenshotToDataUri)
    .filter((s): s is string => s !== null);

  return {
    title: finding.title,
    description: descriptionParts.filter(Boolean).join('\n\n'),
    severity: SEVERITY_MAP[finding.severity] ?? 'medium',
    url: finding.pageUrl ?? targetUrl,
    steps: finding.steps,
    evidence: screenshots.length > 0 ? `${screenshots.length} screenshot(s) attached` : undefined,
    screenshots,
    metadata: {
      area: finding.area,
      confidence: finding.confidence,
      reproRate: finding.reproRate,
      automationCandidate: finding.automationCandidate,
    },
  };
}

export interface RaiseBugsResult {
  created: number;
  bugs: Array<{ id: string; title: string }>;
}

/** Posts the given findings to QualityPilot in one batched call. Never throws — callers get a
 *  clear error message back instead, since this crosses into a separate app's live API and a
 *  failure here (expired token, unreachable host) is routine, not exceptional. */
export async function raiseFindingsInQualityPilot(
  config: QualityPilotConfig,
  state: SessionState,
  findings: Finding[],
): Promise<{ ok: true; result: RaiseBugsResult } | { ok: false; error: string }> {
  const payload = {
    target_url: state.config.targetUrl,
    source: 'exploratory',
    findings: findings.map((f) => findingToExploratoryInput(f, state.config.targetUrl)),
  };

  const url = `${config.baseUrl.replace(/\/$/, '')}/workspaces/${config.workspaceId}/projects/${config.projectId}/exploratory/submit-findings`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        return { ok: false, error: 'QualityPilot rejected the saved API key (401) — check it matches EXPLORATORY_AGENT_API_KEY in QualityPilot\'s backend .env, and that it has been restarted since that value was set.' };
      }
      return { ok: false, error: `QualityPilot returned HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
    const data = (await response.json()) as RaiseBugsResult;
    return { ok: true, result: data };
  } catch (err) {
    return { ok: false, error: `Could not reach QualityPilot at ${config.baseUrl}: ${(err as Error).message}` };
  }
}
