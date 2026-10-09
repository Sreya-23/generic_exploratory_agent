import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Checklist §11 — Concurrency / Race Conditions. Distinct from idempotency.ts, which sends two
 * requests SEQUENTIALLY (one fully resolves before the next fires) — that can't catch a classic
 * TOCTOU race, where the idempotency-key check-then-insert isn't atomic and a genuinely
 * simultaneous second request slips through the gap before the first write commits. This fires
 * requests with Promise.all so they're in flight at the same instant.
 *
 * Only two generic, domain-agnostic race shapes are checkable without knowing the site's
 * business rules: (1) does an Idempotency-Key actually dedupe under true concurrency, and
 * (2) does concurrent writes to the same resource ever leave it in a state that doesn't match
 * ANY of the values that were sent (corruption), as opposed to just "last write won" (which is
 * an acceptable, common outcome this check does NOT flag). Safety: operates only on a resource
 * this check creates itself, same discipline as crud-lifecycle.ts.
 */

const SYNTHETIC_BODY = {
  name: 'QA Concurrency Test Resource',
  title: 'QA Concurrency Test Resource',
  description: 'Created by automated exploratory QA — safe to delete.',
};

function extractId(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const candidates = [parsed, parsed?.data, parsed?.result, parsed?.item].filter(Boolean);
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const id = (c as Record<string, unknown>).id ?? (c as Record<string, unknown>)._id;
        if (id !== undefined && id !== null) return String(id);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function extractField(body: string, field: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const obj = (parsed && typeof parsed === 'object' && (parsed.data ?? parsed.result ?? parsed)) || {};
    const v = (obj as Record<string, unknown>)[field];
    return v !== undefined && v !== null ? String(v) : null;
  } catch {
    return null;
  }
}

export async function testConcurrency(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders', '/api/items']).slice(0, 1);
  if (targets.length === 0) {
    ctx.onLog('[Concurrency] No discovered/plausible write endpoint to test — skipping');
    return 0;
  }
  const path = targets[0];
  let count = 0;

  // ── Concurrent identical requests with the SAME Idempotency-Key ───────────────────────────
  const idempotencyKey = `qa-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let raceResults: Array<{ status: number; body: string }> = [];
  try {
    raceResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY, headers: { 'Idempotency-Key': idempotencyKey } }, headers),
      ),
    );
  } catch {
    raceResults = [];
  }
  const succeeded = raceResults.filter((r) => r.status >= 200 && r.status < 300);
  if (succeeded.length > 1) {
    const ids = new Set(succeeded.map((r) => extractId(r.body)).filter(Boolean));
    if (ids.size > 1) {
      ctx.onFinding({
        severity: 'high',
        area: 'API-Concurrency',
        title: `Idempotency-Key does not prevent duplicate creation under true concurrency: POST ${path}`,
        steps: [
          `Fire 5 simultaneous POST ${path} requests, all using the identical Idempotency-Key header and body`,
          'Compare the resource ids returned across the successful responses',
        ],
        expected: 'Simultaneous requests sharing one Idempotency-Key should result in exactly one created resource',
        actual: `${ids.size} distinct resources were created from ${succeeded.length} successful concurrent requests sharing one Idempotency-Key`,
        evidence: writeApiEvidence(ctx, 'concurrency-idempotency-race', formatEvidence('POST', path, 200, { requestHeaders: { 'Idempotency-Key': idempotencyKey }, responseBody: succeeded.map((r) => r.body).join('\n---\n') })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'verified',
        confidenceReason: 'Directly counted distinct ids from parallel responses to the same idempotency key — a race window in the check-then-insert logic.',
      });
      count++;
    }
  }

  // ── Concurrent updates to the same resource: final state must match a value that was sent ──
  let created;
  try {
    created = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
  } catch {
    created = null;
  }
  if (created && created.status >= 200 && created.status < 300) {
    const id = extractId(created.body);
    if (id) {
      const itemPath = `${path}/${id}`;
      const candidateValues = ['QA Race Value A', 'QA Race Value B', 'QA Race Value C'];
      let updateResults: Array<{ status: number }> = [];
      try {
        updateResults = await Promise.all(
          candidateValues.map((v) =>
            probe(baseUrl, { method: 'PATCH', path: itemPath, body: { name: v, title: v } }, headers),
          ),
        );
      } catch {
        updateResults = [];
      }
      const anySucceeded = updateResults.some((r) => r.status >= 200 && r.status < 300);
      if (anySucceeded) {
        let final;
        try {
          final = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
        } catch {
          final = null;
        }
        if (final && final.status === 200) {
          const finalName = extractField(final.body, 'name') ?? extractField(final.body, 'title');
          if (finalName && !candidateValues.includes(finalName) && finalName !== SYNTHETIC_BODY.name) {
            ctx.onFinding({
              severity: 'high',
              area: 'API-Concurrency',
              title: `Concurrent updates left the resource in a corrupted state: ${itemPath}`,
              steps: [
                `Fire 3 simultaneous PATCH ${itemPath} requests, each with a distinct, known value`,
                `GET ${itemPath} and compare the final value against the 3 values that were sent`,
              ],
              expected: 'The final value should match exactly one of the concurrently-submitted values (last-write-wins is acceptable)',
              actual: `Final value "${finalName}" matches none of the submitted values — suggests a non-atomic read-modify-write under concurrency`,
              evidence: writeApiEvidence(ctx, 'concurrency-corrupted-update', formatEvidence('GET', itemPath, final.status, { responseBody: final.body })),
              reproRate: '1/1',
              automationCandidate: true,
              pageUrl: itemPath,
              confidence: 'heuristic',
              confidenceReason: 'Field-name matching only checks name/title — a schema using different field names, or server-side normalization of the value, could false-positive here.',
            });
            count++;
          }
        }
      }
      // Best-effort cleanup of the resource this check created — not safety-critical either way.
      try { await probe(baseUrl, { method: 'DELETE', path: itemPath }, headers); } catch { /* ignore */ }
    }
  }

  // ── Concurrent DELETE + UPDATE on a fresh resource — final state must be sane ──────────────
  // A fresh resource (not the one above, which was just deleted) so this race starts clean.
  let created2;
  try {
    created2 = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
  } catch {
    created2 = null;
  }
  if (created2 && created2.status >= 200 && created2.status < 300) {
    const id2 = extractId(created2.body);
    if (id2) {
      const itemPath2 = `${path}/${id2}`;
      let raceResults2: Array<{ status: number }> = [];
      try {
        raceResults2 = await Promise.all([
          probe(baseUrl, { method: 'DELETE', path: itemPath2 }, headers),
          probe(baseUrl, { method: 'PATCH', path: itemPath2, body: { name: 'QA Race Delete-Update', title: 'QA Race Delete-Update' } }, headers),
        ]);
      } catch {
        raceResults2 = [];
      }
      if (raceResults2.some((r) => r.status >= 500)) {
        // A race's reproducibility can't be confirmed by resending the SAME request (the
        // original resource may already be gone) — re-run the whole race on a FRESH resource
        // instead, per checklist §35's "single 500 without context" rule.
        let reproduced = false;
        try {
          const createdRetry = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
          const idRetry = createdRetry.status >= 200 && createdRetry.status < 300 ? extractId(createdRetry.body) : null;
          if (idRetry) {
            const itemPathRetry = `${path}/${idRetry}`;
            const retryResults = await Promise.all([
              probe(baseUrl, { method: 'DELETE', path: itemPathRetry }, headers),
              probe(baseUrl, { method: 'PATCH', path: itemPathRetry, body: { name: 'QA Race Delete-Update Retry', title: 'QA Race Delete-Update Retry' } }, headers),
            ]);
            reproduced = retryResults.some((r) => r.status >= 500);
          }
        } catch { /* treat as not reproduced — inconclusive, not confirmed */ }
        ctx.onFinding({
          severity: reproduced ? 'medium' : 'low',
          area: 'API-Concurrency',
          title: `Simultaneous DELETE + PATCH on the same resource crashes the server: ${itemPath2}`,
          steps: [`Fire DELETE ${itemPath2} and PATCH ${itemPath2} simultaneously on a freshly-created resource`, ...(reproduced ? ['Repeated on a second freshly-created resource — reproduced again'] : [])],
          expected: 'One of the two operations should win cleanly (2xx/404/409) — never a server error',
          actual: `Statuses observed: ${raceResults2.map((r) => r.status).join(', ')}`,
          evidence: writeApiEvidence(ctx, 'concurrency-delete-update-crash', formatEvidence('PATCH', itemPath2, raceResults2[1]?.status ?? 0, {})),
          reproRate: reproduced ? '2/2' : '1/2',
          automationCandidate: true,
          pageUrl: itemPath2,
          confidence: reproduced ? 'verified' : 'heuristic',
          confidenceReason: reproduced
            ? 'Reproduced the same crash on a second, independently-created resource under the same race — a deterministic bug, not a one-off timing fluke.'
            : 'Did NOT reproduce when the same race was re-run on a fresh resource — the original 5xx may have been transient. Downgraded to an observation per the "single 500 without context" rule.',
        });
        count++;
      } else {
        let final2;
        try {
          final2 = await probe(baseUrl, { method: 'GET', path: itemPath2 }, headers);
        } catch {
          final2 = null;
        }
        if (final2 && final2.status === 200) {
          const finalName2 = extractField(final2.body, 'name') ?? extractField(final2.body, 'title');
          if (finalName2 !== 'QA Race Delete-Update' && finalName2 !== SYNTHETIC_BODY.name) {
            ctx.onFinding({
              severity: 'medium',
              area: 'API-Concurrency',
              title: `Resource left in an inconsistent state after a simultaneous delete+update race: ${itemPath2}`,
              steps: [`Fire DELETE ${itemPath2} and PATCH ${itemPath2} simultaneously`, `GET ${itemPath2}`],
              expected: 'The resource should end up either fully deleted (404) or cleanly updated (matching the PATCH value) — not some other state',
              actual: `GET returned 200 with a value matching neither "deleted" nor the PATCH value: "${finalName2}"`,
              evidence: writeApiEvidence(ctx, 'concurrency-delete-update-inconsistent', formatEvidence('GET', itemPath2, final2.status, { responseBody: final2.body })),
              reproRate: '1/1',
              automationCandidate: true,
              pageUrl: itemPath2,
              confidence: 'heuristic',
              confidenceReason: 'Field-name matching only checks name/title — a schema using different field names could false-positive here.',
            });
            count++;
          }
        }
        // Best-effort cleanup if the resource survived the race.
        try { await probe(baseUrl, { method: 'DELETE', path: itemPath2 }, headers); } catch { /* ignore */ }
      }
    }
  }

  if (count === 0) {
    ctx.onLog(`[Concurrency] Checked ${path} — no duplicate-creation or corrupted-state race detected`);
  }
  return count;
}
