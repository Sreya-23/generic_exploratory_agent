import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Best-effort extraction of a created-resource identifier from a response body — used only to
 * tell "two requests created two different resources" from "two requests returned the exact
 * same resource," never trusted beyond that comparison. Checks the common shapes (top-level,
 * or nested under data/result) rather than assuming one fixed schema.
 */
function extractId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const direct = parsed?.id ?? parsed?._id;
    if (direct !== undefined) return String(direct);
    for (const key of ['data', 'result', 'order', 'payment', 'booking']) {
      const nested = parsed?.[key] as Record<string, unknown> | undefined;
      const id = nested?.id ?? nested?._id;
      if (id !== undefined) return String(id);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Duplicate-POST / idempotency-key testing (checklist §12/§13): send the SAME write request
 * twice — once plain, once with a matching Idempotency-Key header if the target accepts one —
 * and check whether a double-submit silently creates two separate resources. Same safety
 * posture already established by testMassAssignment/testXssProbe in this file's sibling
 * checks: synthetic, clearly-labeled field values sent to discovered/guessed write endpoints,
 * never real user data, and no attempt to clean up afterward (consistent with existing
 * precedent in this package).
 */
export async function testIdempotency(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  // Collection-style endpoints most likely to be a real "create" action — same guess list
  // spirit as testMassAssignment, biased toward checklist's own named high-risk examples
  // (payment/order/booking) over a generic guess.
  const targets = resolveEndpointPaths(ctx, ['/api/orders', '/api/payments', '/api/bookings']).slice(0, 3);
  if (targets.length === 0) {
    ctx.onLog('[Idempotency] No discovered/plausible write (create) endpoint to test — skipping');
    return 0;
  }

  let count = 0;
  for (const path of targets) {
    const marker = `QA-idempotency-probe-${Date.now()}`;
    const body = { title: marker, name: marker, description: marker };

    try {
      // Plain double-submit — no idempotency key offered. This is the "a user double-clicks
      // Submit, or a client blindly retries after a timeout" scenario.
      const first = await probe(baseUrl, { method: 'POST', path, body }, headers);
      const second = await probe(baseUrl, { method: 'POST', path, body }, headers);

      if (first.status >= 200 && first.status < 300 && second.status >= 200 && second.status < 300) {
        const id1 = extractId(first.body);
        const id2 = extractId(second.body);
        if (id1 && id2 && id1 !== id2) {
          ctx.onFinding({
            severity: 'high',
            area: 'API-Idempotency',
            title: `Identical POST requests created two separate resources: ${path}`,
            steps: [
              `POST ${path} with body: ${JSON.stringify(body)}`,
              'Repeat the exact same request immediately after',
            ],
            expected: 'A double-submitted create request should not silently produce two separate records (duplicate order/payment/booking)',
            actual: `Two 2xx responses with different resource IDs: "${id1}" and "${id2}"`,
            evidence: writeApiEvidence(ctx, 'idempotency-double-submit', formatEvidence('POST', path, second.status, { requestBody: body, responseBody: `First: ${first.body}\nSecond: ${second.body}` })),
            reproRate: '1/1',
            automationCandidate: true,
            confidence: 'verified',
            confidenceReason: 'Directly compares the two real response IDs for an identical back-to-back request — not inferred.',
          });
          count++;
        } else if (!id1 || !id2) {
          ctx.onLog(`[Idempotency] ${path}: both requests returned 2xx but no resource ID could be extracted — cannot confirm duplicate creation either way`);
        } else {
          ctx.onLog(`[Idempotency] ${path}: both requests returned the same resource ID — duplicate submission appears handled correctly`);
        }
      } else {
        ctx.onLog(`[Idempotency] ${path}: second request did not return 2xx (${second.status}) — duplicate submission appears rejected, which is correct behavior`);
      }
    } catch {
      /* this target isn't a real write endpoint — try the next one */
    }

    try {
      // Idempotency-Key variant — only meaningful if the API actually supports this header;
      // a server that ignores unknown headers will behave identically to the plain case above,
      // which is why this is reported separately rather than folded into the same finding.
      const idempotencyKey = `qa-idem-key-${Date.now()}`;
      const keyMarker = `QA-idempotency-key-probe-${Date.now()}`;
      const keyBody = { title: keyMarker, name: keyMarker, description: keyMarker };
      const keyReqHeaders = { 'Idempotency-Key': idempotencyKey };
      const first = await probe(baseUrl, { method: 'POST', path, body: keyBody, headers: keyReqHeaders }, headers);
      const second = await probe(baseUrl, { method: 'POST', path, body: keyBody, headers: keyReqHeaders }, headers);

      if (first.status >= 200 && first.status < 300 && second.status >= 200 && second.status < 300) {
        const id1 = extractId(first.body);
        const id2 = extractId(second.body);
        if (id1 && id2 && id1 !== id2) {
          ctx.onFinding({
            severity: 'medium',
            area: 'API-Idempotency',
            title: `Idempotency-Key header not honored: ${path}`,
            steps: [
              `POST ${path} with header "Idempotency-Key: ${idempotencyKey}" and a body`,
              'Repeat the exact same request (same key, same body) immediately after',
            ],
            expected: 'Two requests sharing the same Idempotency-Key should return the same resource, not create a second one',
            actual: `Two 2xx responses with different resource IDs ("${id1}", "${id2}") despite an identical Idempotency-Key`,
            evidence: writeApiEvidence(ctx, 'idempotency-key-not-honored', formatEvidence('POST', path, second.status, { requestHeaders: keyReqHeaders, requestBody: keyBody, responseBody: `First: ${first.body}\nSecond: ${second.body}` })),
            reproRate: '1/1',
            automationCandidate: true,
            confidence: 'heuristic',
            confidenceReason: 'Assumes the target actually recognizes the Idempotency-Key header convention — if it does not, this is indistinguishable from the plain double-submit case already reported separately, and this finding may just be restating that.',
          });
          count++;
        }
      }
    } catch {
      /* ignore — this header variant simply isn't supported/reachable here */
    }

    try {
      // Checklist §13/§19 — "retry after timeout": simulate a client giving up on a slow
      // request (50ms timeout — guaranteed to abort before any real server responds) and then
      // retrying with the SAME Idempotency-Key. If the original request actually completed
      // server-side despite the client never seeing the response, a correct idempotency
      // implementation still returns the same resource on retry; a duplicate here means the
      // retry path doesn't share the same dedup logic as the simultaneous-request path above.
      const retryKey = `qa-idem-retry-${Date.now()}`;
      const retryMarker = `QA-idempotency-retry-probe-${Date.now()}`;
      const retryBody = { title: retryMarker, name: retryMarker, description: retryMarker };
      try {
        await probe(baseUrl, { method: 'POST', path, body: retryBody, headers: { 'Idempotency-Key': retryKey }, timeoutMs: 50 }, headers);
      } catch {
        /* expected — the client "gave up" exactly as intended */
      }
      await new Promise((r) => setTimeout(r, 500)); // grace period for the server to finish processing in the background
      const retryRes = await probe(baseUrl, { method: 'POST', path, body: retryBody, headers: { 'Idempotency-Key': retryKey } }, headers);
      if (retryRes.status >= 200 && retryRes.status < 300) {
        const listRes = await probe(baseUrl, { method: 'GET', path }, headers);
        const matchCount = (listRes.body.match(new RegExp(retryMarker, 'g')) ?? []).length;
        if (matchCount >= 2) {
          ctx.onFinding({
            severity: 'medium',
            area: 'API-Idempotency',
            title: `Retry after a client timeout creates a duplicate: ${path}`,
            steps: [
              `POST ${path} with a 50ms client timeout (simulating a client giving up on a slow request) using Idempotency-Key: ${retryKey}`,
              'Wait 500ms, then retry the identical request with the SAME Idempotency-Key',
            ],
            expected: 'If the original request actually completed server-side, the retry (same Idempotency-Key) should return the same resource, not create a second one',
            actual: `${matchCount} resources matching the retry marker were found — the timed-out request and the retry both appear to have created separate records`,
            evidence: writeApiEvidence(ctx, 'idempotency-retry-after-timeout', formatEvidence('POST', path, retryRes.status, { requestHeaders: { 'Idempotency-Key': retryKey }, responseBody: retryRes.body })),
            reproRate: '1/1',
            automationCandidate: true,
            confidence: 'heuristic',
            confidenceReason: 'The marker-count check assumes the list endpoint returns recently-created items without pagination hiding one of them — verify both records actually exist before treating as confirmed.',
          });
          count++;
        }
      }
    } catch {
      /* ignore — timeout-simulation variant not reachable on this target */
    }
  }

  return count;
}
