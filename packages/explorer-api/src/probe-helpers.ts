import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorContext } from '@qa/shared';

export interface ApiProbe {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
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
): Promise<{ status: number; body: string; isJson: boolean; contentType: string }> {
  const url = new URL(p.path, baseUrl).toString();
  const res = await fetch(url, {
    method: p.method,
    headers: { ...headers, ...p.headers },
    body: p.body ? JSON.stringify(p.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text().catch(() => '');
  // Determine if this is actually a JSON API response vs SPA catch-all HTML
  const isJson =
    contentType.includes('application/json') ||
    (body.trimStart().startsWith('{') || body.trimStart().startsWith('['));
  return { status: res.status, body: body.slice(0, 500), isJson, contentType };
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
