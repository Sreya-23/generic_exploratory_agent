import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorContext } from '@qa/shared';

let evidenceCounter = 0;

/**
 * Writes the raw request/response detail behind an API finding to a small text file under the
 * session's screenshots dir (the one directory @fastify/static already serves, and the one
 * FindingCard already knows how to build a URL for) and returns it as a `Finding.evidence`
 * entry. Every API check was previously passing `evidence: []` — the finding's `steps`/`actual`
 * text described what happened in prose, but the actual request body and full response body
 * were never captured anywhere, unlike UI flows which always attach a screenshot. Never throws:
 * a failed write just means this one finding has no evidence file, not a failed check.
 */
export function writeApiEvidence(ctx: ExecutorContext, label: string, content: string): string[] {
  try {
    const dir = join(ctx.sessionsDir, ctx.sessionId, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const filename = `api-evidence-${label}-${Date.now()}-${evidenceCounter++}.txt`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, 'utf-8');
    return [filePath];
  } catch {
    return [];
  }
}

export interface CrashConfirmation {
  reproduced: boolean;
  reproRate: string;
  confidence: 'verified' | 'heuristic';
  confidenceReason: string;
}

/**
 * Checklist §35: "a single 500 without context" must be treated as an observation, not a
 * qualified bug — yet every crash-detection check in this package was raising a high/critical
 * finding off exactly one observed 5xx, with `reproRate: '1/1'` hardcoded and no retry anywhere.
 * This re-sends the IDENTICAL request once more before a check escalates severity: if the same
 * request 5xxs again, that's a deterministic bug, not noise (a GC pause, a cold Lambda, a
 * load-balancer hiccup only fails once). Callers should downgrade severity to 'low' when
 * `reproduced` is false, splat the returned fields into the finding, and keep the original
 * severity only when it IS true.
 */
export async function confirmCrashReproduces(
  baseUrl: string,
  p: ApiProbe,
  headers: Record<string, string>,
): Promise<CrashConfirmation> {
  let retryStatus: number;
  try {
    const retry = await probe(baseUrl, p, headers);
    retryStatus = retry.status;
  } catch {
    retryStatus = 599; // a thrown error (timeout/connection reset) on retry is itself still a failure signal
  }
  const reproduced = retryStatus >= 500;
  return {
    reproduced,
    reproRate: reproduced ? '2/2' : '1/2',
    confidence: reproduced ? 'verified' : 'heuristic',
    confidenceReason: reproduced
      ? 'Reproduced on an immediate retry of the identical request — a deterministic server error, not transient flakiness.'
      : 'Did NOT reproduce on an immediate retry of the identical request — the original 5xx may have been transient infrastructure flakiness (GC pause, cold start, load-balancer hiccup) rather than a deterministic bug. Downgraded to an observation per the "single 500 without context" rule; worth a manual re-check, not yet a confirmed defect.',
  };
}

/** Compact, readable request/response summary for an evidence file — not JSON, meant to be
 *  read directly by a human following up on the finding. */
export function formatEvidence(
  method: string,
  path: string,
  status: number,
  opts: { requestBody?: unknown; requestHeaders?: Record<string, string>; responseBody?: string } = {},
): string {
  const lines = [`${method} ${path}`, `Status: ${status}`];
  if (opts.requestHeaders && Object.keys(opts.requestHeaders).length > 0) {
    lines.push(`Request headers: ${JSON.stringify(opts.requestHeaders)}`);
  }
  if (opts.requestBody !== undefined) {
    lines.push(`Request body: ${JSON.stringify(opts.requestBody).slice(0, 2000)}`);
  }
  if (opts.responseBody !== undefined) {
    lines.push(`Response body: ${opts.responseBody.slice(0, 2000)}`);
  }
  return lines.join('\n');
}

export interface ApiProbe {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Overrides the default 15s client timeout — used by checks that deliberately want a SHORT
   *  timeout to simulate a client giving up on a slow request (checklist §13/§19: "retry after
   *  timeout/network failure"), where the server may still complete the write after the client
   *  has already moved on and retried. */
  timeoutMs?: number;
}

/** True only for an actual FormData body (multipart file uploads) — everything else is
 *  treated as a plain JS value to be JSON-stringified, as every other check already assumes. */
function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Extract the logged-in session cookie from Playwright's saved storageState, so
 * API probes hit real endpoints AS the authenticated user rather than as an
 * anonymous caller. Without this, every probe below is unauthenticated regardless
 * of the site's login method — for cookie-session apps (the common case for
 * password logins) that makes IDOR/privilege/mass-assignment checks meaningless,
 * since a correctly-protected endpoint just 401s the same way an insecure one
 * would look to a genuinely unauthenticated caller.
 */
function readSessionCookieHeader(ctx: ExecutorContext): string | null {
  try {
    const stateFile = join(ctx.sessionsDir, ctx.sessionId, 'auth-state.json');
    if (!existsSync(stateFile)) return null;
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { cookies?: StoredCookie[] };
    const origin = new URL(ctx.config.targetUrl).hostname;
    const relevant = (state.cookies ?? []).filter(
      (c) => origin === c.domain || origin.endsWith(c.domain.replace(/^\./, '')),
    );
    if (relevant.length === 0) return null;
    return relevant.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

export function buildHeaders(ctx: ExecutorContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const creds = ctx.config.credentials;
  if (creds?.type === 'bearer' && creds.bearerToken) {
    headers.Authorization = `Bearer ${creds.bearerToken}`;
  } else if (creds?.type === 'api-key' && creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }
  const cookieHeader = readSessionCookieHeader(ctx);
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

export async function probe(
  baseUrl: string,
  p: ApiProbe,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; isJson: boolean; contentType: string; responseHeaders: Record<string, string> }> {
  const url = new URL(p.path, baseUrl).toString();
  // Every write probe in this package sends a JSON-stringified body — without a Content-Type
  // header, a server that strictly parses by content-type would never even see it as JSON,
  // producing a false negative on checks that depend on the body actually being read (mass
  // assignment, idempotency, etc). Set as a DEFAULT (p.headers can still override it) rather
  // than forcing it on every caller to remember individually.
  // A FormData body must NOT get a manual Content-Type — fetch sets its own multipart boundary,
  // and overriding it here would break every file-upload probe's request.
  const isFormData = isFormDataBody(p.body);
  const contentTypeDefault: Record<string, string> = p.body && !isFormData ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, {
    method: p.method,
    headers: { ...headers, ...contentTypeDefault, ...p.headers },
    body: p.body === undefined ? undefined : isFormData ? (p.body as FormData) : JSON.stringify(p.body),
    signal: AbortSignal.timeout(p.timeoutMs ?? 15000),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text().catch(() => '');
  // Determine if this is actually a JSON API response vs SPA catch-all HTML
  const isJson =
    contentType.includes('application/json') ||
    (body.trimStart().startsWith('{') || body.trimStart().startsWith('['));
  const responseHeaders = Object.fromEntries(
    [...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { status: res.status, body: body.slice(0, 500), isJson, contentType, responseHeaders };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. These are all independent,
 * read-only HTTP probes that were previously awaited one at a time for no correctness
 * reason — a check firing N genuinely unrelated requests took N times longer than it needed
 * to. A concurrency cap (rather than unlimited Promise.all) keeps this from turning into a
 * burst of dozens of simultaneous requests against a real target site.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Public endpoints that are intentionally unauthenticated — should never be flagged HIGH
export const PUBLIC_ENDPOINTS = new Set(['/health', '/api/health', '/api/status', '/ping', '/api/ping', '/status']);

export const COMMON_PATHS = ['/api', '/api/v1', '/api/health', '/health', '/api/users', '/api/status'];

/**
 * Returns paths to probe, preferring those actually discovered by recon
 * from the site's real network traffic. Falls back to generic guesses only
 * when recon found nothing.
 */
export function resolveEndpointPaths(ctx: ExecutorContext, fallback: string[]): string[] {
  const discovered = ctx.discoveredApiEndpoints ?? [];
  if (discovered.length > 0) {
    // Extract just the path portion from "GET https://..." or "GET /path"
    const paths = discovered.map((e) => {
      try {
        const parts = e.split(' ');
        const urlPart = parts[1] ?? parts[0];
        return urlPart.startsWith('http') ? new URL(urlPart).pathname : urlPart;
      } catch { return null; }
    }).filter((p): p is string => Boolean(p) && p !== '/');

    const unique = [...new Set(paths)].slice(0, 10);
    if (unique.length > 0) {
      ctx.onLog(`[API] Using ${unique.length} recon-discovered endpoints instead of generic guesses`);
      return unique;
    }
  }
  ctx.onLog(`[API] No recon endpoints available — using ${fallback.length} generic path guesses`);
  return fallback;
}
