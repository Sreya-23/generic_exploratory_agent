import type { ExecutorContext } from '@qa/shared';
import { probe, resolveEndpointPaths, writeApiEvidence, formatEvidence, confirmCrashReproduces } from '../probe-helpers.js';

/**
 * Checklist §13 — File/Payload testing at the API layer. Distinct from explorer-ui's
 * file-upload.ts, which drives a real <input type="file"> through the browser — this targets
 * the raw upload ENDPOINT directly via multipart/form-data, which is the only way to send a
 * deliberately-oversized payload or a crafted filename without the browser's own file picker
 * getting in the way. Only runs against an endpoint whose path plausibly suggests file handling
 * (upload/file/avatar/attachment/image) — guessing a multipart POST at every generic CRUD
 * endpoint would be noisy and low-signal.
 *
 * What this flags: the server CRASHING (5xx) or hanging on an oversized/malformed upload, and
 * (heuristic only) a dangerous executable extension being accepted without any apparent
 * rejection — never asserted as definitely wrong, since server-side content-type sniffing this
 * check can't see might still block it from being served/executed later.
 */

const UPLOAD_PATH_HINTS = ['upload', 'file', 'avatar', 'attachment', 'image', 'document', 'media'];

function looksLikeUploadPath(path: string): boolean {
  const lower = path.toLowerCase();
  return UPLOAD_PATH_HINTS.some((hint) => lower.includes(hint));
}

export async function testFilePayload(
  baseUrl: string,
  headers: Record<string, string>,
  ctx: ExecutorContext,
): Promise<number> {
  const discovered = resolveEndpointPaths(ctx, []).filter(looksLikeUploadPath);
  const targets = discovered.length > 0 ? discovered.slice(0, 2) : ['/api/upload'];
  // Only fall back to the generic guess if nothing upload-shaped was actually discovered AND
  // the fallback itself isn't being tested blind elsewhere — this check is inherently a guess
  // either way, so log clearly which mode it ran in.
  if (discovered.length === 0) {
    ctx.onLog('[FilePayload] No upload-shaped endpoint discovered — trying one generic guess (/api/upload)');
  }

  let count = 0;

  for (const path of targets) {
    // ── Oversized file (5MB) — server should reject cleanly, not crash or hang ──────────────
    try {
      const oversized = new FormData();
      oversized.append('file', new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' }), 'qa-oversized-test.bin');
      const res = await probe(baseUrl, { method: 'POST', path, body: oversized }, headers);
      if (res.status >= 500) {
        // FormData entries hold immutable, re-readable Blobs — safe to reuse the same instance
        // for a second fetch() call rather than re-allocating another 5MB buffer.
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path, body: oversized }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'high' : 'low',
          area: 'API-FileUpload',
          title: `Oversized file upload crashes the server: POST ${path}`,
          steps: [`POST a 5MB multipart file upload to ${path}`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'An oversized upload should be rejected with a 4xx (e.g. 413 Payload Too Large), never a server error',
          actual: `HTTP ${res.status}`,
          evidence: writeApiEvidence(ctx, 'file-oversized', formatEvidence('POST', path, res.status, { responseBody: res.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('timeout') || msg.includes('aborted')) {
        // A single timeout could be generic network slowness, not an upload-size handling bug —
        // retry once before escalating, same "single 500 without context" discipline as a crash.
        let reproduced = false;
        try {
          const retryForm = new FormData();
          retryForm.append('file', new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' }), 'qa-oversized-test.bin');
          await probe(baseUrl, { method: 'POST', path, body: retryForm }, headers);
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message ?? '';
          reproduced = retryMsg.includes('timeout') || retryMsg.includes('aborted');
        }
        ctx.onFinding({
          severity: reproduced ? 'medium' : 'low',
          area: 'API-FileUpload',
          title: `Oversized file upload times out: POST ${path}`,
          steps: [`POST a 5MB multipart file upload to ${path}`, ...(reproduced ? ['Repeated — timed out again on an immediate retry'] : [])],
          expected: 'An oversized upload should be rejected quickly, not hang until timeout',
          actual: 'Request did not complete within 15s',
          evidence: [],
          reproRate: reproduced ? '2/2' : '1/2',
          automationCandidate: true,
          pageUrl: path,
          confidence: reproduced ? 'verified' : 'heuristic',
          confidenceReason: reproduced
            ? 'Timed out twice in a row on the identical request — a consistent handling issue, not one-off network slowness.'
            : 'Did NOT time out on an immediate retry — the original timeout may have been transient network slowness rather than a deterministic upload-size handling bug. Downgraded to an observation.',
        });
        count++;
      }
    }

    // ── Path-traversal filename — should be sanitized, never reflected/crash ────────────────
    try {
      const traversal = new FormData();
      traversal.append('file', new Blob(['qa test content'], { type: 'text/plain' }), '../../../../etc/passwd');
      const res = await probe(baseUrl, { method: 'POST', path, body: traversal }, headers);
      if (res.status >= 500) {
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path, body: traversal }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'high' : 'low',
          area: 'API-FileUpload',
          title: `Path-traversal filename crashes the server: POST ${path}`,
          steps: [`POST a multipart file upload to ${path} with filename "../../../../etc/passwd"`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'A malicious filename should be sanitized/rejected, never cause a server error',
          actual: `HTTP ${res.status}`,
          evidence: writeApiEvidence(ctx, 'file-traversal', formatEvidence('POST', path, res.status, { responseBody: res.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      }
    } catch { /* unreachable — try the next check */ }

    // ── Dangerous executable extension — heuristic only, logged not asserted wrong ──────────
    try {
      const dangerous = new FormData();
      dangerous.append('file', new Blob(['<?php echo "qa-test"; ?>'], { type: 'application/x-php' }), 'qa-test.php');
      const res = await probe(baseUrl, { method: 'POST', path, body: dangerous }, headers);
      if (res.status >= 500) {
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path, body: dangerous }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'medium' : 'low',
          area: 'API-FileUpload',
          title: `Uploading a .php file crashes the server: POST ${path}`,
          steps: [`POST a multipart file upload to ${path} with a .php filename and PHP content`, ...(confirm.reproduced ? ['Repeated — reproduced on an immediate retry'] : [])],
          expected: 'An unexpected file type should be rejected or safely stored, never cause a server error',
          actual: `HTTP ${res.status}`,
          evidence: writeApiEvidence(ctx, 'file-php-extension', formatEvidence('POST', path, res.status, { responseBody: res.body })),
          reproRate: confirm.reproRate,
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      } else if (res.status >= 200 && res.status < 300) {
        ctx.onLog(
          `[FilePayload] ${path}: a .php upload was accepted with HTTP ${res.status} — verify manually whether ` +
          'the storage/serving layer executes uploaded files (not confirmed by this check alone, which cannot see storage config)',
        );
      }
    } catch { /* ignore — not itself evidence */ }

    // ── Duplicate upload — same content uploaded twice shouldn't crash, logged only ──────────
    try {
      const marker = `qa-dup-upload-${Date.now()}`;
      const makeForm = () => {
        const f = new FormData();
        f.append('file', new Blob([marker], { type: 'text/plain' }), 'qa-duplicate-test.txt');
        return f;
      };
      const first = await probe(baseUrl, { method: 'POST', path, body: makeForm() }, headers);
      const second = await probe(baseUrl, { method: 'POST', path, body: makeForm() }, headers);
      if (first.status >= 500 || second.status >= 500) {
        // Two attempts already happened above — a 5xx on EITHER one is itself already a repeat
        // observation (not a single unqualified 500), but confirm once more to be sure it's
        // actually this specific scenario (duplicate content) and not incidental server flakiness.
        const confirm = await confirmCrashReproduces(baseUrl, { method: 'POST', path, body: makeForm() }, headers);
        ctx.onFinding({
          severity: confirm.reproduced ? 'medium' : 'low',
          area: 'API-FileUpload',
          title: `Uploading identical content twice crashes the server: POST ${path}`,
          steps: [`POST the same file content to ${path} twice in a row`, ...(confirm.reproduced ? ['Repeated a third time — reproduced again'] : [])],
          expected: 'A duplicate upload should be handled cleanly (either accepted again or rejected), never a server error',
          actual: `Statuses: ${first.status}, ${second.status}`,
          evidence: writeApiEvidence(ctx, 'file-duplicate-crash', formatEvidence('POST', path, Math.max(first.status, second.status), {})),
          reproRate: confirm.reproduced ? '3/3' : '1/3',
          automationCandidate: true,
          pageUrl: path,
          confidence: confirm.confidence,
          confidenceReason: confirm.confidenceReason,
        });
        count++;
      } else {
        ctx.onLog(`[FilePayload] ${path}: duplicate upload handled cleanly (${first.status}, ${second.status})`);
      }
    } catch { /* ignore */ }
  }

  if (count === 0) {
    ctx.onLog(`[FilePayload] Checked ${targets.length} upload endpoint(s) — no crashes/timeouts on oversized or malformed uploads`);
  }
  return count;
}
