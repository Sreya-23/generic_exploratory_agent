import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Checklist §18 — Error Handling: does the API return a RECOGNIZABLE, CONSISTENT error shape
 * across different endpoints, and does an error response ever leak a stack trace? Distinct from
 * malformed-input.ts (which only asserts "must not 5xx") — this looks at the actual 4xx body
 * shape itself. Triggers a guaranteed-invalid request (empty body on a write endpoint) against
 * each discovered endpoint and inspects what comes back.
 */

const STACK_TRACE_SIGNATURES = [
  /at \S+ \(.*:\d+:\d+\)/, // Node.js stack frame
  /Traceback \(most recent call last\)/, // Python
  /\.java:\d+\)/, // Java stack frame
  /#\d+ \S+\(\): /, // PHP stack trace
  /node_modules\/[^\s"]+\.js/,
];

function errorShapeKey(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    const keys = ['error', 'message', 'errors', 'detail', 'error_description'].filter(
      (k) => (parsed as Record<string, unknown>)[k] !== undefined,
    );
    return keys.length > 0 ? keys.sort().join(',') : 'no-recognizable-error-field';
  } catch {
    return 'non-json-body';
  }
}

export async function testErrorConsistency(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders', '/api/products']).slice(0, 4);
  if (targets.length === 0) {
    ctx.onLog('[ErrorConsistency] No discovered/plausible endpoint to test — skipping');
    return 0;
  }

  let count = 0;
  const shapesSeen = new Map<string, string>(); // shapeKey -> first path that showed it

  for (const path of targets) {
    let res;
    try {
      res = await probe(baseUrl, { method: 'POST', path, body: {} }, headers);
    } catch {
      continue;
    }
    if (res.status < 400 || res.status >= 500) continue; // only care about actual 4xx error bodies here

    const stackLeak = STACK_TRACE_SIGNATURES.find((re) => re.test(res.body));
    if (stackLeak) {
      ctx.onFinding({
        severity: 'high',
        area: 'API-ErrorHandling',
        title: `Error response leaks a stack trace: POST ${path}`,
        steps: [`POST ${path} with an empty body (triggers a validation error)`, 'Inspect the error response body'],
        expected: 'An error response should be a clean, user-facing message — never an internal stack trace',
        actual: `HTTP ${res.status} response body contains a stack trace matching ${stackLeak}`,
        evidence: writeApiEvidence(ctx, 'error-stack-leak', formatEvidence('POST', path, res.status, { responseBody: res.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'verified',
        confidenceReason: 'A stack-trace-shaped string in a 4xx error body is unambiguous — internal error details reached the client.',
      });
      count++;
    }

    const shapeKey = errorShapeKey(res.body);
    if (shapeKey && !shapesSeen.has(shapeKey)) shapesSeen.set(shapeKey, path);
  }

  if (shapesSeen.size > 1) {
    const examples = [...shapesSeen.entries()].map(([shape, p]) => `${p} → ${shape}`).join('; ');
    ctx.onFinding({
      severity: 'low',
      area: 'API-ErrorHandling',
      title: 'Error response shape is inconsistent across endpoints',
      steps: targets.map((p) => `POST ${p} with an empty body`),
      expected: 'Error responses should use a consistent field name (e.g. always "error" or always "message") across all endpoints',
      actual: `${shapesSeen.size} different error body shapes observed: ${examples}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      confidence: 'heuristic',
      confidenceReason: 'Different endpoints (or different frameworks/versions behind an API gateway) may legitimately format errors differently — verify this is actually unintended before treating as a real defect.',
    });
    count++;
  }

  if (count === 0) {
    ctx.onLog(`[ErrorConsistency] Checked ${targets.length} endpoint(s) — consistent error shape, no stack-trace leaks`);
  }
  return count;
}
