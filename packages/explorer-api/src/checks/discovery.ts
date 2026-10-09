import type { ExecutorContext } from '@qa/shared';
import { probe, mapWithConcurrency, resolveEndpointPaths, writeApiEvidence, formatEvidence, COMMON_PATHS } from '../probe-helpers.js';

// Checklist §1 — "Identify high-risk APIs such as payment, booking, transfer, delete, password
// and user-management APIs." Purely a classification tag on an already-discovered endpoint —
// doesn't change whether/how it's probed, just flags it for a human triaging findings later.
const HIGH_RISK_KEYWORDS = /\b(payment|pay|charge|refund|transfer|checkout|order|booking|delete|remove|password|reset-password|admin|user-management|users?\/\d|role|permission)\b/i;

export function classifyEndpointRisk(path: string): 'high-risk' | 'standard' {
  return HIGH_RISK_KEYWORDS.test(path) ? 'high-risk' : 'standard';
}

/**
 * Checklist §1 — API Discovery via an OpenAPI/Swagger spec, when the user provides one
 * (`config.openApiUrl`). Previously a completely dead field — accepted by the session config,
 * threaded through to ExecutorContext, and never read anywhere. Parses `paths` from the spec
 * (supports both OpenAPI 3.x and Swagger 2.x, which use the same top-level `paths` shape) and
 * merges them into `ctx.discoveredApiEndpoints` so every other check benefits from a complete,
 * authoritative endpoint list instead of guesses/BFS-discovered traffic alone.
 */
export async function discoverFromOpenApiSpec(ctx: ExecutorContext): Promise<number> {
  const specUrl = ctx.config.openApiUrl;
  if (!specUrl) return 0;

  let spec: unknown;
  try {
    const res = await fetch(specUrl, { signal: AbortSignal.timeout(10000) });
    spec = await res.json();
  } catch (err) {
    ctx.onLog(`[API-Discovery] Could not fetch/parse OpenAPI spec at ${specUrl}: ${(err as Error).message}`);
    return 0;
  }

  const paths = (spec as { paths?: Record<string, Record<string, unknown>> })?.paths;
  if (!paths || typeof paths !== 'object') {
    ctx.onLog(`[API-Discovery] ${specUrl} did not contain a recognizable "paths" object`);
    return 0;
  }

  const entries: string[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options'].includes(method.toLowerCase())) {
        entries.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  if (entries.length === 0) return 0;

  ctx.discoveredApiEndpoints = [...new Set([...(ctx.discoveredApiEndpoints ?? []), ...entries])];
  ctx.onLog(`[API-Discovery] Parsed ${entries.length} endpoint(s) from OpenAPI spec at ${specUrl}`);

  const highRisk = entries.filter((e) => classifyEndpointRisk(e) === 'high-risk');
  if (highRisk.length > 0) {
    ctx.onLog(`[API-Discovery] ${highRisk.length} endpoint(s) classified high-risk (payment/delete/password/admin/etc): ${highRisk.slice(0, 10).join(', ')}`);
  }
  return entries.length;
}

export async function probeCommonEndpoints(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  await discoverFromOpenApiSpec(ctx);

  // Prefer real endpoints from recon; fall back to generic guesses
  const pathsToProbe = resolveEndpointPaths(ctx, COMMON_PATHS);
  ctx.onLog(`[API] Probing ${pathsToProbe.length} endpoints on ${baseUrl}`);

  const hits = await mapWithConcurrency(pathsToProbe, 5, async (path) => {
    try {
      const res = await probe(baseUrl, { method: 'GET', path }, headers);
      ctx.onLog(`[API] GET ${path} → ${res.status} (${res.contentType.split(';')[0]})`);

      if (res.status === 200 && res.isJson) {
        const risk = classifyEndpointRisk(path);
        ctx.onFinding({
          severity: 'info',
          area: 'API-Discovery',
          title: `Discovered JSON API endpoint${risk === 'high-risk' ? ' (high-risk)' : ''}: GET ${path}`,
          steps: [`GET ${path}`],
          expected: 'Endpoint exists',
          actual: `HTTP 200 with JSON response${risk === 'high-risk' ? ' — path suggests a payment/delete/password/admin-shaped operation, prioritize for manual review' : ''}`,
          evidence: writeApiEvidence(ctx, 'discovery', formatEvidence('GET', path, res.status, { responseBody: res.body })),
          reproRate: '1/1',
          automationCandidate: true,
          tags: risk === 'high-risk' ? ['high-risk-endpoint'] : undefined,
        });
        return true;
      } else if (res.status === 200 && !res.isJson) {
        ctx.onLog(`[API] GET ${path} → 200 HTML (SPA catch-all) — not a real API endpoint`);
      }
    } catch {
      /* endpoint may not exist */
    }
    return false;
  });
  return hits.filter(Boolean).length;
}
