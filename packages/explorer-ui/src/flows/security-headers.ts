// F6/F7/F8 — Security response headers, cookie flags, clickjacking exposure.
// Cheap and high-signal: a single response's headers + the current cookie jar tell you
// a lot about the app's real security posture, and directly complement any finding about
// where auth state actually lives (e.g. "auth stored outside cookies" pairs naturally with
// "here's exactly which cookies exist and which security flags they're missing").
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

const REQUIRED_HEADERS: Array<{ header: string; label: string; severity: 'low' | 'medium' }> = [
  { header: 'content-security-policy', label: 'Content-Security-Policy', severity: 'low' },
  { header: 'strict-transport-security', label: 'Strict-Transport-Security (HSTS)', severity: 'low' },
  { header: 'x-content-type-options', label: 'X-Content-Type-Options', severity: 'low' },
  { header: 'referrer-policy', label: 'Referrer-Policy', severity: 'low' },
];

export async function runSecurityHeadersCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const url = page.url();
  ctx.onLog(`[SecurityHeaders] Inspecting response headers and cookies for ${url}`);

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  if (!response) {
    ctx.onLog('[SecurityHeaders] Could not reload the page to inspect headers — skipping');
    return;
  }
  const headers = response.headers();

  // ── Missing security headers ────────────────────────────────────────────
  const missing = REQUIRED_HEADERS.filter(({ header }) => !headers[header]);
  if (missing.length > 0) {
    ctx.onFinding({
      severity: missing.length >= 3 ? 'medium' : 'low',
      area: 'Security-Headers',
      title: `${missing.length} security response header(s) missing`,
      steps: [`Request ${url}`, 'Inspect response headers (DevTools → Network → Headers)'],
      expected: 'Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options, and Referrer-Policy should all be present',
      actual: `Missing: ${missing.map((m) => m.label).join(', ')}`,
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: url,
    });
  }

  // ── Clickjacking exposure — X-Frame-Options OR CSP frame-ancestors ──────
  const csp = headers['content-security-policy'] ?? '';
  const hasFrameAncestors = /frame-ancestors/i.test(csp);
  const hasXFrameOptions = !!headers['x-frame-options'];
  if (!hasFrameAncestors && !hasXFrameOptions) {
    ctx.onFinding({
      severity: 'medium',
      area: 'Security-Headers',
      title: 'No clickjacking protection (X-Frame-Options or CSP frame-ancestors)',
      steps: [
        `Request ${url}`,
        'Check for X-Frame-Options header or Content-Security-Policy frame-ancestors directive',
        'Try embedding the page in an <iframe> on another origin',
      ],
      expected: 'X-Frame-Options: DENY/SAMEORIGIN, or CSP frame-ancestors, present on authenticated pages',
      actual: 'Neither X-Frame-Options nor a CSP frame-ancestors directive was found — page can likely be framed by another origin',
      evidence: [],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: url,
    });
  }

  // ── Cookie flags ─────────────────────────────────────────────────────────
  const cookies = await page.context().cookies();
  if (cookies.length === 0) {
    ctx.onLog(
      '[SecurityHeaders] No cookies set at all — consistent with auth being stored outside cookies ' +
        '(localStorage/sessionStorage) rather than a security-header gap',
    );
  } else {
    const weak = cookies.filter((c) => !c.httpOnly || !c.secure || c.sameSite === 'None');
    if (weak.length > 0) {
      ctx.onFinding({
        severity: 'medium',
        area: 'Security-Headers',
        title: `${weak.length} of ${cookies.length} cookie(s) missing secure flags`,
        steps: [`Log in and reach ${url}`, 'Inspect cookies in DevTools → Application → Cookies'],
        expected: 'Session-relevant cookies should set httpOnly, secure, and SameSite=Lax or Strict',
        actual: weak
          .map((c) => `${c.name}: httpOnly=${c.httpOnly}, secure=${c.secure}, sameSite=${c.sameSite ?? 'none'}`)
          .join('; '),
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
      });
    }
  }

  ctx.onLog(
    `[SecurityHeaders] Done — ${missing.length} header(s) missing, ` +
      `clickjacking protection: ${hasFrameAncestors || hasXFrameOptions ? 'present' : 'absent'}, ` +
      `${cookies.length} cookie(s) inspected`,
  );
}
