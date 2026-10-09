import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence, confirmCrashReproduces } from '../probe-helpers.js';

/**
 * Checklist §1/§9/§10 combined: CRUD Lifecycle, Status Code Validation, and Data Consistency —
 * at the API layer. Distinct from generic-crud.ts (UI-driven, clicks through forms) and from
 * testMassAssignment (which creates a resource once to probe field acceptance and never reads
 * it back). This check walks the FULL chain — create → get → update → get → delete → get — on
 * one self-created synthetic resource, and checks that each step's effect is actually visible
 * in the next GET, not just that the write call itself returned 2xx.
 *
 * Safety: only ever acts on the id returned by this check's OWN create call. Never guesses or
 * reuses an existing id for the update/delete steps — unlike IDOR/privilege checks (which
 * intentionally probe other-user ids as their entire point), this check's goal is lifecycle
 * correctness, so touching a real pre-existing resource would add risk with no corresponding
 * test value. If create fails or doesn't yield an id, the target is skipped entirely.
 */

const SYNTHETIC_CREATE_BODY = {
  name: 'QA Lifecycle Test Resource',
  title: 'QA Lifecycle Test Resource',
  description: 'Created by automated exploratory QA — safe to delete.',
};

const SYNTHETIC_UPDATE_BODY = {
  name: 'QA Lifecycle Test Resource (updated)',
  title: 'QA Lifecycle Test Resource (updated)',
  description: 'Updated by automated exploratory QA — safe to delete.',
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

function fieldsMatch(body: string, expected: Record<string, string>): boolean {
  try {
    const parsed = JSON.parse(body);
    const obj = (parsed && typeof parsed === 'object' && (parsed.data ?? parsed.result ?? parsed)) || {};
    return Object.entries(expected).every(([k, v]) => String((obj as Record<string, unknown>)[k] ?? '') === v);
  } catch {
    return false;
  }
}

export async function testCrudLifecycle(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/products', '/api/items']).slice(0, 2);
  if (targets.length === 0) {
    ctx.onLog('[CrudLifecycle] No discovered/plausible write endpoint to test — skipping');
    return 0;
  }

  let count = 0;

  for (const path of targets) {
    let created;
    try {
      created = await probe(baseUrl, { method: 'POST', path, body: SYNTHETIC_CREATE_BODY }, headers);
    } catch {
      continue;
    }
    if (created.status < 200 || created.status >= 300) {
      ctx.onLog(`[CrudLifecycle] ${path}: create returned ${created.status} — skipping lifecycle chain for this endpoint`);
      continue;
    }
    const id = extractId(created.body);
    if (!id) {
      ctx.onLog(`[CrudLifecycle] ${path}: create succeeded but no id found in response — can't safely continue the chain`);
      continue;
    }
    const itemPath = `${path}/${id}`;

    // ── Status code validation: create should be 200/201, not something unexpected ──────────
    if (created.status !== 200 && created.status !== 201) {
      ctx.onFinding({
        severity: 'low',
        area: 'API-StatusCodes',
        title: `Unconventional status code on resource creation: POST ${path}`,
        steps: [`POST ${path} with a valid body`],
        expected: 'A successful creation should return 201 Created (or 200)',
        actual: `HTTP ${created.status}`,
        evidence: writeApiEvidence(ctx, 'crud-create-status', formatEvidence('POST', path, created.status, { requestBody: SYNTHETIC_CREATE_BODY, responseBody: created.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: path,
        confidence: 'heuristic',
        confidenceReason: 'Some APIs intentionally return 202 Accepted for async creation — verify this endpoint is actually synchronous before treating as a defect.',
      });
      count++;
    }

    // ── Data consistency: the created resource must be immediately retrievable ──────────────
    let afterCreate;
    try {
      afterCreate = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
    } catch {
      continue;
    }
    if (afterCreate.status !== 200) {
      ctx.onFinding({
        severity: 'high',
        area: 'API-DataConsistency',
        title: `Created resource is not retrievable immediately after creation: ${itemPath}`,
        steps: [`POST ${path} (succeeded with ${created.status})`, `GET ${itemPath}`],
        expected: 'A just-created resource should be immediately readable via its own URL',
        actual: `GET ${itemPath} returned HTTP ${afterCreate.status}`,
        evidence: writeApiEvidence(ctx, 'crud-create-unreadable', formatEvidence('GET', itemPath, afterCreate.status, { responseBody: afterCreate.body })),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: itemPath,
        confidence: 'verified',
        confidenceReason: 'Directly observed: the create call reported success, but the resource it supposedly created cannot be read back.',
      });
      count++;
      continue; // no point continuing the chain on a resource we can't even read
    } else if (!fieldsMatch(afterCreate.body, { name: SYNTHETIC_CREATE_BODY.name })
            && !fieldsMatch(afterCreate.body, { title: SYNTHETIC_CREATE_BODY.title })) {
      ctx.onLog(`[CrudLifecycle] ${itemPath}: created resource readable, but field-match check inconclusive (schema may use different field names)`);
    }

    // ── Update: PATCH, then verify the change is actually persisted on the next GET ─────────
    let updated;
    try {
      updated = await probe(baseUrl, { method: 'PATCH', path: itemPath, body: SYNTHETIC_UPDATE_BODY }, headers);
    } catch {
      updated = null;
    }
    if (updated && updated.status >= 200 && updated.status < 300) {
      let afterUpdate;
      try {
        afterUpdate = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
      } catch {
        afterUpdate = null;
      }
      if (afterUpdate && afterUpdate.status === 200) {
        const persisted = fieldsMatch(afterUpdate.body, { name: SYNTHETIC_UPDATE_BODY.name })
                        || fieldsMatch(afterUpdate.body, { title: SYNTHETIC_UPDATE_BODY.title });
        if (!persisted) {
          ctx.onFinding({
            severity: 'high',
            area: 'API-DataConsistency',
            title: `Update reports success but the change isn't persisted: ${itemPath}`,
            steps: [`PATCH ${itemPath} (succeeded with ${updated.status})`, `GET ${itemPath}`, 'Compare the returned fields against the update payload'],
            expected: 'A successful update should be visible on the very next GET of the same resource',
            actual: `PATCH returned ${updated.status}, but GET ${itemPath} still shows the pre-update values`,
            evidence: writeApiEvidence(ctx, 'crud-update-not-persisted', formatEvidence('GET', itemPath, afterUpdate.status, { responseBody: afterUpdate.body })),
            reproRate: '1/1',
            automationCandidate: true,
            pageUrl: itemPath,
            confidence: 'heuristic',
            confidenceReason: 'Field-name matching is heuristic (name/title only) — a schema using different field names could false-positive here.',
          });
          count++;
        }
      }
    }

    // ── Checklist §4 — HTTP Method Validation for PUT specifically: full-replace via PUT on
    // the SAME self-created resource (zero risk — it's ours), distinct from method-validation.ts
    // which deliberately never sends PUT/PATCH/DELETE to a guessed real endpoint. If the API
    // supports PUT, a full-replace body should be reflected the same way PATCH's partial update
    // already was; if the API doesn't support PUT at all, a clean 404/405 is expected, never 5xx.
    let putRes;
    try {
      putRes = await probe(baseUrl, { method: 'PUT', path: itemPath, body: SYNTHETIC_UPDATE_BODY }, headers);
    } catch {
      putRes = null;
    }
    if (putRes && putRes.status >= 500) {
      const confirm = await confirmCrashReproduces(baseUrl, { method: 'PUT', path: itemPath, body: SYNTHETIC_UPDATE_BODY }, headers);
      ctx.onFinding({
        severity: confirm.reproduced ? 'high' : 'low',
        area: 'API-MethodValidation',
        title: `PUT crashes the server instead of a clean response: ${itemPath}`,
        steps: [`PUT ${itemPath} (a resource this check created) with a full-replace body`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
        expected: 'PUT should either perform a full replace (2xx) or return 404/405 if unsupported — never a server error',
        actual: `HTTP ${putRes.status}`,
        evidence: writeApiEvidence(ctx, 'crud-put-crash', formatEvidence('PUT', itemPath, putRes.status, { requestBody: SYNTHETIC_UPDATE_BODY, responseBody: putRes.body })),
        reproRate: confirm.reproRate,
        automationCandidate: true,
        pageUrl: itemPath,
        confidence: confirm.confidence,
        confidenceReason: confirm.confidenceReason,
      });
      count++;
    }

    // ── Delete: verify the resource is actually gone afterward, not just that DELETE 2xx'd ──
    let deleted;
    try {
      deleted = await probe(baseUrl, { method: 'DELETE', path: itemPath }, headers);
    } catch {
      deleted = null;
    }
    if (deleted && deleted.status >= 200 && deleted.status < 300) {
      let afterDelete;
      try {
        afterDelete = await probe(baseUrl, { method: 'GET', path: itemPath }, headers);
      } catch {
        afterDelete = null;
      }
      if (afterDelete && afterDelete.status === 200) {
        ctx.onFinding({
          severity: 'medium',
          area: 'API-DataConsistency',
          title: `Deleted resource is still retrievable: ${itemPath}`,
          steps: [`DELETE ${itemPath} (succeeded with ${deleted.status})`, `GET ${itemPath}`],
          expected: 'A deleted resource should return 404/410 on a subsequent GET',
          actual: `GET ${itemPath} still returns HTTP 200 after a successful DELETE`,
          evidence: writeApiEvidence(ctx, 'crud-delete-not-gone', formatEvidence('GET', itemPath, afterDelete.status, { responseBody: afterDelete.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: itemPath,
          confidence: 'heuristic',
          confidenceReason: 'Could be an intentional soft-delete (resource flagged inactive but still fetchable by id) rather than a bug — check whether the response body reflects a deleted/inactive state before treating as confirmed.',
        });
        count++;
      }
    } else {
      ctx.onLog(`[CrudLifecycle] ${itemPath}: DELETE returned ${deleted?.status ?? 'an error'} — leftover synthetic test resource may remain (safe to ignore/delete manually, created by this check)`);
    }
  }

  if (count === 0) {
    ctx.onLog(`[CrudLifecycle] Checked ${targets.length} endpoint(s) — full create/get/update/get/delete/get chain is consistent`);
  }
  return count;
}
