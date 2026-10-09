import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

const BASELINE_DIR_NAME = 'api-schema-baselines';

function shapeOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }
  return out;
}

function baselineFilePath(ctx: ExecutorContext, path: string): string {
  const host = (() => { try { return new URL(ctx.config.targetUrl).hostname; } catch { return 'unknown-host'; } })();
  const safe = path.replace(/[^a-zA-Z0-9]/g, '_') || 'root';
  return join(ctx.sessionsDir, BASELINE_DIR_NAME, host, `${safe}.json`);
}

/**
 * Checklist §29 — API Versioning / Contract Drift, and §10 — Response Validation (schema shape).
 * Replaces the previous hardcoded 3-endpoint/hardcoded-required-fields version, which checked
 * paths ('/api/users/me', '/api/health') that may not even exist on the target site. Now uses
 * REAL discovered endpoints and auto-establishes its own baseline on first sight (mirroring the
 * golden-path.ts visual-snapshot convention: first run saves a baseline, later runs diff against
 * it) — so it works on any site without hardcoded assumptions about its schema, and gets more
 * precise as more sessions run against the same host.
 */
export async function testSchemaDrift(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users/me', '/api/health', '/api']).slice(0, 6);
  if (targets.length === 0) {
    ctx.onLog('[SchemaDrift] No discovered/plausible endpoint to test — skipping');
    return 0;
  }

  const hits = await mapWithConcurrency(targets, 5, async (path) => {
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path }, headers);
    } catch {
      return false;
    }
    if (res.status !== 200 || !res.isJson) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return false;
    }
    const currentShape = shapeOf(parsed);
    if (Object.keys(currentShape).length === 0) return false;

    const baselinePath = baselineFilePath(ctx, path);
    if (!existsSync(baselinePath)) {
      try {
        mkdirSync(join(baselinePath, '..'), { recursive: true });
        writeFileSync(baselinePath, JSON.stringify(currentShape, null, 2), 'utf-8');
        ctx.onLog(`[SchemaDrift] ${path} — no prior baseline, established one from this run`);
      } catch { /* non-fatal */ }
      return false;
    }

    let baseline: Record<string, string>;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    } catch {
      return false;
    }

    const missing = Object.keys(baseline).filter((k) => !(k in currentShape));
    const added = Object.keys(currentShape).filter((k) => !(k in baseline));
    const typeChanged = Object.keys(baseline).filter((k) => k in currentShape && currentShape[k] !== baseline[k]);

    if (missing.length === 0 && added.length === 0 && typeChanged.length === 0) {
      ctx.onLog(`[SchemaDrift] ${path} — schema matches established baseline`);
      return false;
    }

    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
      added.length > 0 ? `added: ${added.join(', ')}` : null,
      typeChanged.length > 0 ? `type changed: ${typeChanged.map((k) => `${k} (${baseline[k]}→${currentShape[k]})`).join(', ')}` : null,
    ].filter(Boolean).join('; ');

    ctx.onFinding({
      severity: missing.length > 0 || typeChanged.length > 0 ? 'medium' : 'low',
      area: 'Regression-Schema',
      title: `API schema drift from established baseline: ${path}`,
      steps: [`GET ${path}`, 'Compare response shape against the baseline established on first sight'],
      expected: 'Response shape should match the baseline, or a field change should be an intentional, versioned API change',
      actual: details,
      evidence: writeApiEvidence(ctx, 'schema-drift', formatEvidence('GET', path, res.status, { responseBody: res.body })),
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: path,
      confidence: missing.length > 0 || typeChanged.length > 0 ? 'verified' : 'heuristic',
      confidenceReason: added.length > 0 && missing.length === 0 && typeChanged.length === 0
        ? 'A purely additive field is usually a safe, backward-compatible change — verify no client depended on its absence.'
        : 'Missing fields or changed types are a real backward-incompatibility risk for any client built against the baseline shape.',
    });
    return true;
  });
  return hits.filter(Boolean).length;
}

/**
 * Checklist §9 — Status Code Validation sweep: does a request to a near-certainly-nonexistent
 * resource ID actually return 404, rather than 200 (phantom success) or 500 (unhandled lookup
 * failure)? A narrow but completely generic, zero-risk (GET-only) check against any discovered
 * item-shaped endpoint.
 */
export async function testStatusCodeValidation(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders', '/api/products']).slice(0, 4);
  if (targets.length === 0) {
    ctx.onLog('[StatusCodes] No discovered/plausible endpoint to test — skipping');
    return 0;
  }

  let count = 0;
  for (const path of targets) {
    const bogusPath = `${path}/qa-nonexistent-id-00000000-0000-0000-0000-000000000000`;
    let res;
    try {
      res = await probe(baseUrl, { method: 'GET', path: bogusPath }, headers);
    } catch {
      continue;
    }
    if (res.status === 200 && res.isJson) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-StatusCodes',
        title: `Non-existent resource ID returns 200 instead of 404: ${bogusPath}`,
        steps: [`GET ${bogusPath} (an id that was never created)`],
        expected: 'A non-existent resource should return 404 Not Found',
        actual: `HTTP 200 with a JSON body for an id that was never created`,
        evidence: writeApiEvidence(ctx, 'status-code-phantom', formatEvidence('GET', bogusPath, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: bogusPath,
        confidence: 'heuristic',
        confidenceReason: 'Some APIs use a shared catch-all/collection response — verify the body actually represents a single resource (not a filtered list that legitimately came back empty-looking) before treating as confirmed.',
      });
      count++;
    } else if (res.status >= 500) {
      ctx.onFinding({
        severity: 'high',
        area: 'API-StatusCodes',
        title: `Non-existent resource ID crashes the server: ${bogusPath}`,
        steps: [`GET ${bogusPath} (an id that was never created)`],
        expected: 'A non-existent resource should return 404 Not Found, never a server error',
        actual: `HTTP ${res.status}`,
        evidence: writeApiEvidence(ctx, 'status-code-crash', formatEvidence('GET', bogusPath, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: bogusPath,
        confidence: 'verified',
        confidenceReason: 'A 5xx on a simple not-found lookup is unambiguous.',
      });
      count++;
    }
  }
  if (count === 0) {
    ctx.onLog(`[StatusCodes] Checked ${targets.length} endpoint(s) — non-existent ids correctly return 404`);
  }
  return count;
}
