import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence, confirmCrashReproduces } from '../probe-helpers.js';

// Checklist §4 — HTTP Method Validation. Deliberately excludes PUT/PATCH/DELETE entirely —
// unlike testMassAssignment (which accepts the residual risk of a real write to probe field
// acceptance), this check's whole point is verifying the server REJECTS an unexpected method
// cleanly, so there's no value-safety tradeoff that would justify sending a method capable of
// actually mutating/deleting a real resource. OPTIONS is always safe; a bodyless POST to a
// GET-only endpoint carries negligible mutation risk and is exactly the failure mode (method
// not validated at all) this check exists to catch.
export async function testHttpMethodValidation(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/health']).slice(0, 6);
  if (targets.length === 0) {
    ctx.onLog('[HttpMethods] No discovered/plausible endpoint to test — skipping');
    return 0;
  }

  let count = 0;
  for (const path of targets) {
    try {
      const optionsRes = await probe(baseUrl, { method: 'OPTIONS', path }, headers);
      if (optionsRes.status >= 500) {
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'OPTIONS', path }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'medium' : 'low',
          area: 'API-MethodValidation',
          title: `OPTIONS request crashes the server: ${path}`,
          steps: [`Send OPTIONS ${path}`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'An OPTIONS request should return 2xx/204/404/405, never a server error',
          actual: `HTTP ${optionsRes.status} on OPTIONS ${path}`,
          evidence: writeApiEvidence(ctx, 'method-options-crash', formatEvidence('OPTIONS', path, optionsRes.status, { responseBody: optionsRes.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      }
    } catch {
      /* unreachable for OPTIONS on this path — not itself evidence of anything */
    }

    try {
      // No body at all — this is testing whether the method itself is validated, not
      // re-running the mass-assignment/XSS probes that already send real payloads elsewhere.
      const postRes = await probe(baseUrl, { method: 'POST', path }, headers);
      if (postRes.status >= 500) {
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'medium' : 'low',
          area: 'API-MethodValidation',
          title: `Unexpected POST crashes the server instead of a clean rejection: ${path}`,
          steps: [`Send a bodyless POST to ${path} (a confirmed GET endpoint)`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'An unsupported method on a GET-only endpoint should return 404/405, not a server error',
          actual: `HTTP ${postRes.status} on POST ${path}`,
          evidence: writeApiEvidence(ctx, 'method-post-crash', formatEvidence('POST', path, postRes.status, { responseBody: postRes.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      } else if (postRes.status >= 200 && postRes.status < 300) {
        ctx.onFinding({
          severity: 'low',
          area: 'API-MethodValidation',
          title: `POST silently accepted on a GET-only endpoint: ${path}`,
          steps: [`Send a bodyless POST to ${path} (a confirmed GET endpoint)`],
          expected: 'An endpoint that only supports GET should reject other methods with 404/405',
          actual: `HTTP ${postRes.status} — the server accepted POST without any body as if it were valid`,
          evidence: writeApiEvidence(ctx, 'method-post-silent-accept', formatEvidence('POST', path, postRes.status, { responseBody: postRes.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'heuristic',
          confidenceReason: 'A permissive router (e.g. a catch-all handler) returning 2xx to any method on any path is a common, often-harmless pattern — verify this endpoint is genuinely meant to be GET-only before treating as confirmed.',
        });
        count++;
      }
    } catch {
      /* ignore — try the next target */
    }
  }

  if (count === 0) {
    ctx.onLog(`[HttpMethods] All ${targets.length} target(s) handled unexpected methods cleanly (no 5xx, no silent 2xx)`);
  }
  return count;
}
