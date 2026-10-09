import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Checklist §14 — Async/Background Job API testing. Deliberately conditional: without knowing
 * the site's actual job/webhook infrastructure, there's nothing generic to assert about a
 * webhook callback (no way to register a receiver, no way to know the expected payload shape).
 * What IS genuinely checkable black-box is the 202 Accepted contract itself — if any discovered
 * endpoint returns 202, this verifies the response actually gives a way to track completion
 * (a job/task id, or a Location/poll URL) and that polling it resolves within a bounded window,
 * rather than being an opaque "accepted" with no way to ever know if it finished or failed.
 * If nothing in the recon/guess set ever returns 202, this check finds nothing to do and exits
 * cleanly — it does not manufacture a finding out of the absence of async behavior.
 */

const SYNTHETIC_BODY = {
  name: 'QA Async Test Resource',
  title: 'QA Async Test Resource',
  description: 'Created by automated exploratory QA — safe to delete.',
};

function findJobReference(body: string, headers: Record<string, string>): string | null {
  const location = headers['location'];
  if (location) return location;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['jobId', 'taskId', 'id', 'statusUrl', 'pollUrl', 'location']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' || typeof v === 'number') return String(v);
      }
    }
  } catch { /* not JSON */ }
  return null;
}

function extractStatusField(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>).status ?? (parsed as Record<string, unknown>).state;
      if (typeof v === 'string') return v.toLowerCase();
    }
  } catch { /* not JSON */ }
  return null;
}

export async function testAsyncOperations(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders', '/api/jobs', '/api/exports']).slice(0, 3);
  if (targets.length === 0) {
    ctx.onLog('[AsyncOps] No discovered/plausible endpoint to test — skipping');
    return 0;
  }

  let count = 0;
  let found202 = false;

  for (const path of targets) {
    let created;
    try {
      created = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
    } catch {
      continue;
    }
    if (created.status !== 202) continue;
    found202 = true;

    const jobRef = findJobReference(created.body, created.responseHeaders);
    if (!jobRef) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-AsyncOperations',
        title: `202 Accepted response gives no way to track completion: POST ${path}`,
        steps: [`POST ${path}`, 'Inspect the 202 response body and headers for a job id, status URL, or Location header'],
        expected: 'A 202 Accepted response should include a job/task id, Location header, or poll URL so the caller can check completion',
        actual: 'No job id, status URL, or Location header found in the 202 response',
        evidence: writeApiEvidence(ctx, 'async-no-tracking', formatEvidence('POST', path, created.status, { responseBody: created.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'heuristic',
        confidenceReason: 'The reference could be under a field name this check does not recognize — verify the actual response shape before treating as confirmed.',
      });
      count++;
      continue;
    }

    // ── Poll the job reference up to 5 times over ~10s, check it resolves ───────────────────
    const pollPath = jobRef.startsWith('http') ? new URL(jobRef).pathname : jobRef;
    let resolved = false;
    let lastStatus: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      let poll;
      try {
        poll = await probe(baseUrl, { method: 'GET', path: pollPath }, headers);
      } catch {
        break;
      }
      if (poll.status >= 400) break;
      lastStatus = extractStatusField(poll.body);
      if (!lastStatus || !['pending', 'processing', 'queued', 'in_progress'].includes(lastStatus)) {
        resolved = true;
        break;
      }
    }
    if (!resolved && lastStatus) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-AsyncOperations',
        title: `Async job never resolves within a reasonable window: ${pollPath}`,
        steps: [`POST ${path} (returned 202 with job reference ${jobRef})`, `Poll ${pollPath} every 2s for 5 attempts (~10s)`],
        expected: 'An async job should transition out of pending/processing within a reasonable time for a trivial, synthetic test payload',
        actual: `Job status remained "${lastStatus}" after 5 polling attempts over ~10s`,
        evidence: writeApiEvidence(ctx, 'async-never-resolves', formatEvidence('GET', pollPath, 0, { responseBody: `Last status: ${lastStatus}` })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: pollPath,
        confidence: 'heuristic',
        confidenceReason: 'A legitimately heavier job (e.g. a real export/report) may just take longer than 10s — increase the polling window before treating as confirmed.',
      });
      count++;
    }
  }

  // Checklist §30 — Webhooks: cannot be actively tested (no way to register a receiver this
  // agent controls), but if a discovered endpoint's path/query literally mentions a callback/
  // webhook URL parameter, that's worth a passive, informational note for manual follow-up
  // rather than silently saying nothing about webhooks at all.
  const webhookShaped = (ctx.discoveredApiEndpoints ?? []).filter((e) => /callback|webhook/i.test(e));
  if (webhookShaped.length > 0) {
    ctx.onFinding({
      severity: 'info',
      area: 'API-AsyncOperations',
      title: `Webhook/callback-shaped endpoint(s) discovered — not automatable by this agent`,
      steps: webhookShaped.map((e) => `Discovered: ${e}`),
      expected: 'N/A — informational only',
      actual: `${webhookShaped.length} endpoint(s) with "callback"/"webhook" in the path were discovered; this agent cannot register a receiver to verify delivery, ordering, retries, or duplicate-event handling — manual verification needed`,
      evidence: [],
      reproRate: 'n/a',
      automationCandidate: false,
    });
    count++;
  }

  if (!found202) {
    ctx.onLog(`[AsyncOps] Checked ${targets.length} endpoint(s) — none returned 202 Accepted, nothing async to verify`);
  } else if (count === 0) {
    ctx.onLog('[AsyncOps] Async job(s) found and resolved within the polling window — no issues');
  }
  return count;
}
