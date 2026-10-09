import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence } from '../probe-helpers.js';

/**
 * Whether `field` actually comes back set to `value` in the response — NOT just whether
 * `value`'s raw text happens to appear anywhere in the body. A bare substring check
 * (the previous approach) false-positives hard on any endpoint that returns boilerplate
 * like {"success":true} for every request regardless of what was sent: probing isAdmin=true
 * or verified=true would "match" on that unrelated success flag, not on the field being
 * reflected at all. Parses JSON and checks the field (top-level or one level nested, since
 * APIs commonly wrap the payload in data/user/result) against the actual value with type
 * awareness; falls back to a key-near-value regex only for non-JSON bodies.
 */
function reflectsField(body: string, field: string, value: string | number | boolean): boolean {
  try {
    const parsed = JSON.parse(body);
    if (objectHasField(parsed, field, value)) return true;
    for (const key of ['data', 'user', 'result', 'profile']) {
      const nested = (parsed as Record<string, unknown>)?.[key];
      if (nested && typeof nested === 'object' && objectHasField(nested, field, value)) return true;
    }
    return false;
  } catch {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`["']?${escapedField}["']?\\s*[:=]\\s*["']?${escapedValue}\\b`, 'i').test(body);
  }
}

function objectHasField(obj: unknown, field: string, value: string | number | boolean): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const actual = (obj as Record<string, unknown>)[field];
  return actual !== undefined && String(actual) === String(value);
}

export async function testMassAssignment(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const sensitiveFields = [
    { field: 'role', value: 'admin' },
    { field: 'isAdmin', value: true },
    { field: 'verified', value: true },
    { field: 'credits', value: 999999 },
    { field: 'balance', value: 999999 },
  ];

  // Real discovered traffic during navigation is GET-only (no forms were submitted),
  // so there's rarely a captured write endpoint to target directly. Derive plausible
  // update targets from discovered collection paths (";/me" and the bare collection)
  // instead of assuming a hardcoded /api/users/me that only matches a narrow class
  // of REST APIs.
  const collectionPaths = resolveEndpointPaths(ctx, ['/api/users']).slice(0, 3);
  const targets = new Set<string>(['/api/users/me']);
  for (const p of collectionPaths) {
    const base = p.replace(/\/$/, '');
    targets.add(`${base}/me`);
    targets.add(base);
  }

  const combos = [...targets].flatMap((path) =>
    (['PATCH', 'PUT', 'POST'] as const).flatMap((method) =>
      sensitiveFields.map((sf) => ({ path, method, sf })),
    ),
  );
  const hits = await mapWithConcurrency(combos, 5, async ({ path, method, sf }) => {
    try {
      const { status, body } = await probe(
        baseUrl,
        { method, path, body: { [sf.field]: sf.value } },
        headers,
      );

      if (status === 200 && reflectsField(body, sf.field, sf.value)) {
        ctx.onFinding({
          severity: 'high',
          area: 'Security-MassAssignment',
          title: `Mass assignment accepted sensitive field: "${sf.field}" via ${method} ${path}`,
          steps: [`${method} ${path} with body: {"${sf.field}": ${JSON.stringify(sf.value)}}`],
          expected: 'Sensitive field ignored or rejected with 400',
          actual: `HTTP 200 and field value "${sf.value}" appears in response body`,
          evidence: writeApiEvidence(ctx, 'mass-assignment', formatEvidence(method, path, status, { requestBody: { [sf.field]: sf.value }, responseBody: body })),
          reproRate: '1/1',
          automationCandidate: true,
        });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  const count = hits.filter(Boolean).length;

  if (count === 0) {
    ctx.onLog(
      `[MassAssignment] No sensitive field accepted across ${targets.size} target(s) — ` +
      'note: without a captured write endpoint, this checks plausible update targets rather than ' +
      'a confirmed one; a clean result here is weaker evidence than a clean result on a known write path',
    );
  }
  return count;
}

/**
 * HTTP-level reflected-XSS probe: send common script payloads both as query params
 * (search/filter-style reflection) and as write-request field values, then check
 * whether the raw, unescaped payload survives in the response body. This catches
 * "input echoed back verbatim" — a real and common class of reflected XSS — but
 * cannot detect DOM-based/stored XSS that only manifests when a browser actually
 * renders the page, since this never touches a real DOM.
 */
export async function testXssProbe(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const payloads = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "';alert(1);//"];
  const targets = resolveEndpointPaths(ctx, ['/api/search', '/api/users']).slice(0, 3);
  const combos = targets.flatMap((basePath) => payloads.map((payload) => ({ basePath, payload })));

  const hitCounts = await mapWithConcurrency(combos, 5, async ({ basePath, payload }) => {
    let hits = 0;
    try {
      const path = `${basePath}?search=${encodeURIComponent(payload)}&q=${encodeURIComponent(payload)}`;
      const { status, body } = await probe(baseUrl, { method: 'GET', path }, headers);
      if (status === 200 && body.includes(payload)) {
        ctx.onFinding({
          severity: 'high',
          area: 'Security-XSS',
          title: `Unescaped payload reflected in query response: ${basePath}`,
          steps: [`GET ${basePath}?search=${payload}`],
          expected: 'User input reflected in responses should be HTML/JSON-escaped',
          actual: `Raw payload "${payload}" appears unescaped in the response body`,
          evidence: writeApiEvidence(ctx, 'xss-reflected-get', formatEvidence('GET', path, status, { responseBody: body })),
          reproRate: '1/1',
          automationCandidate: true,
        });
        hits++;
      }
    } catch {
      /* ignore */
    }

    try {
      const { status, body } = await probe(
        baseUrl,
        {
          method: 'POST',
          path: basePath,
          body: { name: payload, title: payload, comment: payload, content: payload },
        },
        headers,
      );
      if (status === 200 && body.includes(payload)) {
        ctx.onFinding({
          severity: 'high',
          area: 'Security-XSS',
          title: `Unescaped payload accepted and reflected: POST ${basePath}`,
          steps: [`POST ${basePath} with a text field set to: ${payload}`],
          expected: 'Free-text fields should be sanitized or escaped before being echoed back',
          actual: `Raw payload "${payload}" appears unescaped in the response body`,
          evidence: writeApiEvidence(ctx, 'xss-reflected-post', formatEvidence('POST', basePath, status, { requestBody: { name: payload, title: payload, comment: payload, content: payload }, responseBody: body })),
          reproRate: '1/1',
          automationCandidate: true,
        });
        hits++;
      }
    } catch {
      /* ignore */
    }
    return hits;
  });
  const count = hitCounts.reduce((a, b) => a + b, 0);

  if (count === 0) {
    ctx.onLog(
      `[XSS] No unescaped payload reflection detected across ${targets.length} target(s) — ` +
      'note: this is an HTTP-level check only and cannot detect stored/DOM-based XSS that requires ' +
      'a real browser render',
    );
  }
  return count;
}
