import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence, confirmCrashReproduces } from '../probe-helpers.js';

// Checklist §8 — common DB error signatures leaking straight into an API response body is a
// much stronger, directly-confirmable signal of a real SQL/NoSQL injection issue than "the
// server happened to 500" — these strings only ever appear when a raw driver/DB error reached
// the response unhandled, which is itself the defect (information disclosure at minimum, a real
// injection point at worst).
const DB_ERROR_SIGNATURES = [
  /SQL syntax.*MySQL/i,
  /ORA-\d{5}/,
  /SQLSTATE\[/,
  /PostgreSQL.*ERROR/i,
  /SQLite3?::/,
  /Unclosed quotation mark/i,
  /System\.Data\.SqlClient/,
  /pg_query\(\)/,
  /Warning.*\Wmysqli?_/i,
  /MongoError/,
  /E11000 duplicate key/,
];

/**
 * Checklist §5/§6/§7/§8 combined: Request Validation, Data-Type Testing, Boundary Testing,
 * and Special-Character/Injection testing beyond XSS. Grouped into one file because they're
 * really the same underlying action (send a write request with a deliberately wrong-shaped
 * body, see how the server degrades) with different payload generators — not different
 * mechanics. Same safety posture as testMassAssignment: synthetic field values sent to
 * discovered/guessed write endpoints, no attempt to manage/clean up afterward.
 *
 * What this asserts a finding on: the server CRASHING (5xx) on malformed input, which is
 * always a real bug regardless of what the "correct" validation behavior should have been.
 * What it does NOT assert: that a 200 on a malformed body is wrong — without knowing the
 * actual schema, a field this check assumes is required might genuinely be optional, so a
 * clean 2xx is only logged, never flagged as a confirmed defect on its own.
 */

const MALFORMED_BODIES: Array<{ label: string; body: object }> = [
  { label: 'empty object', body: {} },
  { label: 'null fields', body: { name: null, title: null, email: null, amount: null } },
  { label: 'empty-string fields', body: { name: '', title: '', email: '' } },
  { label: 'wrong type — number where string expected', body: { name: 12345, title: 67890, email: 11111 } },
  { label: 'wrong type — string where number expected', body: { amount: 'not-a-number', quantity: 'many', price: 'free', age: 'old' } },
  { label: 'wrong type — boolean where string expected', body: { name: true, title: false } },
  { label: 'wrong type — array where object expected', body: ['unexpected', 'array', 'body'] },
  { label: 'deeply nested unexpected object', body: { name: { nested: { too: { deep: 'value' } } } } },
  { label: 'duplicate-looking keys via odd casing', body: { Name: 'a', name: 'b', NAME: 'c' } },
  { label: 'negative numeric values', body: { amount: -1, quantity: -999, price: -0.01, age: -5 } },
  { label: 'extremely large numeric values', body: { amount: Number.MAX_SAFE_INTEGER, quantity: 1e21 } },
  { label: 'very long string (10,000 chars)', body: { name: 'A'.repeat(10000), title: 'B'.repeat(10000) } },
  { label: 'SQL injection payload', body: { name: "' OR '1'='1", title: "'; DROP TABLE users;--", email: "admin'--" } },
  { label: 'NoSQL injection payload', body: { name: { $ne: null }, title: { $gt: '' } } },
  { label: 'path traversal payload', body: { name: '../../../../etc/passwd', title: '..\\..\\windows\\system32' } },
  { label: 'unexpected extra/unknown fields', body: { name: 'QA Test', title: 'QA Test', qaUnknownField1: 'unexpected', qaUnknownNested: { a: 1 } } },
];

export async function testMalformedInput(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const targets = resolveEndpointPaths(ctx, ['/api/users', '/api/orders']).slice(0, 2);
  if (targets.length === 0) {
    ctx.onLog('[MalformedInput] No discovered/plausible write endpoint to test — skipping');
    return 0;
  }

  const combos = targets.flatMap((path) => MALFORMED_BODIES.map((mb) => ({ path, mb })));
  let crashCount = 0;
  let acceptedCount = 0;

  const results = await mapWithConcurrency(combos, 5, async ({ path, mb }) => {
    try {
      const res = await probe(baseUrl, { method: 'POST', path, body: mb.body }, headers);
      const dbLeak = DB_ERROR_SIGNATURES.find((re) => re.test(res.body));
      if (dbLeak) {
        ctx.onFinding({
          severity: 'critical',
          area: 'API-RequestValidation',
          title: `Raw database error leaked in response: POST ${path} (${mb.label})`,
          steps: [`POST ${path} with body: ${JSON.stringify(mb.body).slice(0, 200)}`, 'Inspect the response body for a raw DB driver error'],
          expected: 'Input should be validated/escaped before reaching the database; any DB error should be caught and returned as a generic error, never passed through raw',
          actual: `Response body contains a raw database error matching ${dbLeak}`,
          evidence: writeApiEvidence(ctx, 'malformed-input-dbleak', formatEvidence('POST', path, res.status, { requestBody: mb.body, responseBody: res.body })),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: path,
          confidence: 'verified',
          confidenceReason: 'A raw DB driver error string in an API response is unambiguous — it only appears when an unescaped/unhandled DB error reached the client.',
        });
        return 'crash';
      }
      if (res.status >= 500) {
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path, body: mb.body }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'high' : 'low',
          area: 'API-RequestValidation',
          title: `Malformed input (${mb.label}) crashes the server: POST ${path}`,
          steps: [`POST ${path} with body: ${JSON.stringify(mb.body).slice(0, 200)}`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'Malformed/invalid input should be rejected with a 4xx validation error, never a 5xx server error',
          actual: `HTTP ${res.status} — the server errored instead of validating the request`,
          evidence: writeApiEvidence(ctx, 'malformed-input', formatEvidence('POST', path, res.status, { requestBody: mb.body, responseBody: res.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        return 'crash';
      }
      if (res.status >= 200 && res.status < 300) return 'accepted';
      return 'rejected';
    } catch {
      return 'unreachable';
    }
  });

  crashCount = results.filter((r) => r === 'crash').length;
  acceptedCount = results.filter((r) => r === 'accepted').length;

  if (crashCount === 0) {
    ctx.onLog(
      `[MalformedInput] ${combos.length} malformed payload(s) tested across ${targets.length} target(s) — ` +
        `0 server errors, ${acceptedCount} accepted with 2xx (not necessarily wrong — schema unknown), ` +
        `${combos.length - acceptedCount} rejected`,
    );
  }
  return crashCount;
}
