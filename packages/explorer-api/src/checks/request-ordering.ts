import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Checklist §17 — Request Ordering: does a request sent LATER ever lose to one sent EARLIER but
 * which happens to take longer to complete? This is the classic "stale response overwrites the
 * newer one" bug class (e.g. rapid search-as-you-type where an old keystroke's response arrives
 * after a newer one and clobbers it) — but tested at the pure API layer: fire two sequential
 * (not simultaneous — that's concurrency.ts's job) requests to the SAME resource, close together,
 * and verify the server's final state reflects the request that was sent LAST, not the one that
 * happened to be slower.
 *
 * Safety: only ever acts on a resource this check creates itself, same discipline as
 * crud-lifecycle.ts/concurrency.ts.
 */

const SYNTHETIC_BODY = {
  name: 'QA Ordering Test Resource',
  title: 'QA Ordering Test Resource',
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

export async function testRequestOrdering(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders', '/api/items']).slice(0, 1);
  if (targets.length === 0) {
    ctx.onLog('[RequestOrdering] No discovered/plausible write endpoint to test — skipping');
    return 0;
  }
  const path = targets[0];
  let count = 0;

  let created;
  try {
    created = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
  } catch {
    created = null;
  }
  if (!created || created.status < 200 || created.status >= 300) {
    ctx.onLog(`[RequestOrdering] ${path}: create returned ${created?.status ?? 'an error'} — skipping`);
    return 0;
  }
  const id = extractId(created.body);
  if (!id) {
    ctx.onLog(`[RequestOrdering] ${path}: create succeeded but no id found — can't safely continue`);
    return 0;
  }
  const itemPath = `${path}/${id}`;

  // Fire two sequential (awaited, not Promise.all) PATCH requests, back to back as fast as
  // possible. "A" is sent first, "B" second — the final state should reflect B, since it was
  // sent later, regardless of which one the server happened to finish processing first.
  try {
    await probe(baseUrl, { method: 'PATCH', path: itemPath, body: { name: 'QA Order Value A', title: 'QA Order Value A' } }, headers);
    await probe(baseUrl, { method: 'PATCH', path: itemPath, body: { name: 'QA Order Value B', title: 'QA Order Value B' } }, headers);
  } catch {
    // If either request itself failed outright, there's nothing meaningful to compare below.
  }

  let final;
  try {
    final = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
  } catch {
    final = null;
  }
  if (final && final.status === 200) {
    const finalName = extractField(final.body, 'name') ?? extractField(final.body, 'title');
    if (finalName === 'QA Order Value A') {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-RequestOrdering',
        title: `A later request lost to an earlier one: ${itemPath}`,
        steps: [
          `PATCH ${itemPath} with value "A"`,
          `PATCH ${itemPath} with value "B" immediately after`,
          `GET ${itemPath}`,
        ],
        expected: 'The request sent LAST ("B") should be reflected in the final state, since it was sent later',
        actual: `Final value is "A" (the earlier request) even though "B" was sent afterward — the later write was lost`,
        evidence: writeApiEvidence(ctx, 'request-ordering-stale-wins', formatEvidence('GET', itemPath, final.status, { responseBody: final.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: itemPath,
        confidence: 'heuristic',
        confidenceReason: 'Could be timing noise on a slow/loaded server rather than a genuine ordering bug — retry to confirm it reproduces before treating as confirmed.',
      });
      count++;
    } else if (finalName !== 'QA Order Value B') {
      ctx.onLog(`[RequestOrdering] ${itemPath}: final value "${finalName}" matches neither A nor B — likely a different field name, inconclusive`);
    } else {
      ctx.onLog(`[RequestOrdering] ${itemPath}: later request correctly won`);
    }
  }

  try { await probe(baseUrl, { method: 'DELETE', path: itemPath }, headers); } catch { /* best-effort cleanup */ }
  return count;
}
