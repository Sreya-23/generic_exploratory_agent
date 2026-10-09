import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence, confirmCrashReproduces } from '../probe-helpers.js';

/**
 * Checklist §26 — State Transition Testing, at the API layer. Distinct from crud-lifecycle.ts
 * (generic create/update/delete, no concept of a business state machine). This is conditional:
 * it only activates if the self-created resource's response actually has a status/state field
 * with a recognizable value — without that signal, there's no state machine to test, and
 * guessing one would be pure noise. When present, this checks two generic, domain-agnostic
 * state-machine properties that hold regardless of what the specific states are:
 *   1. Repeating the current state (setting status to the value it's already at) shouldn't be
 *      silently treated as a meaningful transition — most real systems accept it harmlessly, but
 *      if the server visibly errors on it that's its own (lower-severity) bug.
 *   2. An implausible reverse transition on a resource that looks newly-created (e.g. forcing
 *      status to "completed"/"approved"/"paid" on a resource that was never processed) should be
 *      rejected, not silently accepted — accepting it means the API has no transition validation
 *      at all, letting a client set any resource straight to a terminal/privileged state.
 *
 * Safety: only ever acts on a resource this check creates itself.
 */

const SYNTHETIC_BODY = {
  name: 'QA State Transition Test Resource',
  title: 'QA State Transition Test Resource',
};

const SUSPICIOUS_TERMINAL_STATES = ['completed', 'approved', 'paid', 'confirmed', 'shipped', 'closed', 'cancelled', 'canceled', 'rejected', 'done', 'finished'];

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

function extractStatusField(body: string): { field: string; value: string } | null {
  try {
    const parsed = JSON.parse(body);
    const obj = (parsed && typeof parsed === 'object' && (parsed.data ?? parsed.result ?? parsed)) || {};
    for (const field of ['status', 'state']) {
      const v = (obj as Record<string, unknown>)[field];
      if (typeof v === 'string' && v.length > 0 && v.length < 40) return { field, value: v.toLowerCase() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function testStateTransition(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/orders', '/api/bookings', '/api/users']).slice(0, 1);
  if (targets.length === 0) {
    ctx.onLog('[StateTransition] No discovered/plausible write endpoint to test — skipping');
    return 0;
  }
  const path = targets[0];

  let created;
  try {
    created = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_BODY }, headers);
  } catch {
    created = null;
  }
  if (!created || created.status < 200 || created.status >= 300) return 0;

  const id = extractId(created.body);
  const currentState = extractStatusField(created.body);
  if (!id || !currentState) {
    ctx.onLog(`[StateTransition] ${path}: created resource has no recognizable status/state field — no state machine to test, skipping`);
    return 0;
  }
  const itemPath = `${path}/${id}`;
  let count = 0;

  // ── Implausible reverse/forward transition straight to a terminal state ────────────────────
  const targetState = SUSPICIOUS_TERMINAL_STATES.find((s) => s !== currentState.value) ?? 'completed';
  let forced;
  try {
    forced = await probe(baseUrl, { method: 'PATCH', path: itemPath, body: { [currentState.field]: targetState } }, headers);
  } catch {
    forced = null;
  }
  if (forced && forced.status >= 200 && forced.status < 300) {
    let after;
    try {
      after = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
    } catch {
      after = null;
    }
    const afterState = after && after.status === 200 ? extractStatusField(after.body) : null;
    if (afterState && afterState.value === targetState) {
      ctx.onFinding({
        severity: 'medium',
        area: 'API-StateTransition',
        title: `A newly-created resource can be forced straight to a terminal state: ${itemPath}`,
        steps: [
          `Create a resource (starts at ${currentState.field}="${currentState.value}")`,
          `PATCH ${itemPath} with { "${currentState.field}": "${targetState}" } directly, skipping any intermediate steps`,
          `GET ${itemPath}`,
        ],
        expected: `A transition straight from "${currentState.value}" to "${targetState}" should be rejected if intermediate states/approvals are normally required`,
        actual: `The resource's ${currentState.field} is now "${targetState}" — the API accepted an unconditional state jump with no validation`,
        evidence: writeApiEvidence(ctx, 'state-transition-forced', formatEvidence('PATCH', itemPath, forced.status, { requestBody: { [currentState.field]: targetState }, responseBody: after?.body ?? '' })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: itemPath,
        confidence: 'heuristic',
        confidenceReason: 'Some resources genuinely have no intermediate states and this transition is legitimate — verify this resource type actually requires a multi-step workflow before treating as confirmed.',
      });
      count++;
    }
  }

  // ── Repeating the current state shouldn't error ─────────────────────────────────────────────
  let repeat;
  try {
    repeat = await probe(baseUrl, { method: 'PATCH', path: itemPath, body: { [currentState.field]: currentState.value } }, headers);
  } catch {
    repeat = null;
  }
  if (repeat && repeat.status >= 500) {
    const confirm = await confirmCrashReproduces(baseUrl, { method: 'PATCH', path: itemPath, body: { [currentState.field]: currentState.value } }, headers);
    ctx.onFinding({
      severity: 'low',
      area: 'API-StateTransition',
      title: `Re-applying the current state crashes the server: ${itemPath}`,
      steps: [`PATCH ${itemPath} with { "${currentState.field}": "${currentState.value}" } — the value it's already at`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
      expected: 'Setting a resource to the state it is already in should be a harmless no-op, not a server error',
      actual: `HTTP ${repeat.status}`,
      evidence: writeApiEvidence(ctx, 'state-transition-repeat-crash', formatEvidence('PATCH', itemPath, repeat.status, { requestBody: { [currentState.field]: currentState.value } })),
      reproRate: confirm.reproRate,
      automationCandidate: true,
      pageUrl: itemPath,
      confidence: confirm.confidence,
      confidenceReason: confirm.confidenceReason,
    });
    count++;
  }

  try { await probe(baseUrl, { method: 'DELETE', path: itemPath }, headers); } catch { /* best-effort cleanup */ }

  if (count === 0) {
    ctx.onLog(`[StateTransition] ${itemPath}: state-machine validation looks sound (no unconditional terminal-state jump, no crash on repeat)`);
  }
  return count;
}
