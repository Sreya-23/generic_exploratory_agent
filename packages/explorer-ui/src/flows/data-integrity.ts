import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isRiskyActionLabel, findVisibleErrorText, findVisibleSuccessText, waitForRealContent } from './helpers.js';
import { classifyInputRisk } from './forms.js';

// The one thing every other flow in this codebase is structurally blind to: whether what the
// UI TELLS the user actually matches what the backend DID. Every other check reasons about the
// DOM, or about an HTTP response, in isolation — none of them correlate the two for the same
// action. This closes that specific gap: click a save/create/update action, capture the real
// network response it triggers, capture what the UI displays afterward, and flag the two
// classic silent-integrity bugs this can catch that neither Playwright-DOM-only nor
// API-only checks ever could:
//   1. Backend request failed (4xx/5xx) but the UI still shows a success confirmation —
//      the user believes their data was saved when it wasn't.
//   2. Backend request succeeded (2xx) but the UI shows an error — the user retries or
//      abandons something that actually already went through (e.g. a double-submitted payment).
const CANDIDATE_ACTION_PATTERN = /^(save|create|add|update|submit|confirm)\b/i;

// §22 — Zero feedback: distinct from the mismatch cases below (which need a real HTTP
// response to correlate against). This catches the case where a save/submit action produces
// NO visible feedback at all — no toast, no error, no navigation, no on-page text change — so
// the user has no way to know whether anything happened. A plain content-length/URL diff is a
// coarse signal (relative timestamps etc. can shift it), so this is always reported as a
// heuristic finding, never 'verified'.
async function captureContentSignature(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
}

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string | undefined> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `data-integrity-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch {
    return undefined;
  }
}

export async function runDataIntegrityCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const button = page
    .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
    .filter({ hasText: CANDIDATE_ACTION_PATTERN })
    .first();

  if ((await button.count().catch(() => 0)) === 0) {
    ctx.onLog('[DataIntegrity] No save/create/update-style action found on this page — nothing to check');
    return;
  }

  const label = ((await button.textContent().catch(() => '')) ?? 'Submit').trim().slice(0, 60);
  if (isRiskyActionLabel(label)) {
    ctx.onLog(`[DataIntegrity] "${label}" matches a risky-action pattern — skipping rather than gating a heuristic probe`);
    return;
  }

  // Only fill fields already classified 'safe' elsewhere in this codebase — never invent
  // data for anything that could be a real recipient/PII field, same discipline as forms.ts.
  const inputs = await page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):visible, textarea:visible').all();
  let filledAny = false;
  for (const el of inputs.slice(0, 15)) {
    const name = (await el.getAttribute('name').catch(() => '')) || '';
    const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
    const type = (await el.getAttribute('type').catch(() => '')) || 'text';
    const currentValue = (await el.inputValue().catch(() => '')) || '';
    if (currentValue) continue; // don't overwrite already-filled fields
    const risk = classifyInputRisk(name, placeholder, placeholder || name, type);
    if (risk !== 'safe') continue;
    const required = await el.getAttribute('required').catch(() => null);
    if (required === null && !filledAny) continue; // prefer required fields first, but fill at least one safe field if none are marked required
    await el.fill(`QA data-integrity probe ${Date.now()}`.slice(0, 60)).catch(() => {});
    filledAny = true;
  }

  const urlBefore = page.url();
  const contentBefore = await captureContentSignature(page);

  const targetUrl = new URL(page.url()).origin;
  const responses: Array<{ status: number; url: string; body?: string }> = [];
  const onResponse = async (res: import('playwright').Response) => {
    const req = res.request();
    if (!['POST', 'PUT', 'PATCH'].includes(req.method())) return;
    if (!res.url().startsWith(targetUrl)) return;
    const entry: { status: number; url: string; body?: string } = { status: res.status(), url: res.url() };
    if (res.status() >= 200 && res.status() < 300) {
      entry.body = await res.text().catch(() => undefined);
    }
    responses.push(entry);
  };
  page.on('response', onResponse);

  try {
    await button.click({ timeout: 5000 }).catch((e) => {
      throw new Error(`click failed: ${(e as Error).message.slice(0, 150)}`);
    });
    await page.waitForTimeout(1500);
    await waitForRealContent(page).catch(() => {});

    const [successText, errorText] = await Promise.all([
      findVisibleSuccessText(page, 300),
      findVisibleErrorText(page, 300),
    ]);

    const failedResponse = responses.find((r) => r.status >= 400);
    const okResponse = responses.find((r) => r.status >= 200 && r.status < 300);

    const contentAfter = await captureContentSignature(page);
    const urlChanged = page.url() !== urlBefore;
    const contentChanged = contentAfter !== contentBefore;
    const zeroFeedback = !successText && !errorText && !urlChanged && !contentChanged;

    if (responses.length === 0) {
      if (zeroFeedback) {
        ctx.onFinding({
          severity: 'low',
          area: 'UI-DataIntegrity',
          title: `"${label}" produces no visible feedback of any kind`,
          steps: [`Open ${page.url()}`, `Click "${label}"`, 'Observe the page for any confirmation, error, or navigation'],
          expected: 'An action button gives the user some visible indication that the click was registered (toast, message, navigation, or state change)',
          actual: `No network request, no success/error message, no URL change, and no on-page text change followed clicking "${label}" — a user cannot tell whether anything happened`,
          evidence: [await shot(page, ctx, 'zero-feedback-no-request')].filter((x): x is string => !!x),
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
          confidence: 'heuristic',
          confidenceReason: 'Based on a coarse before/after content and URL diff — a genuinely silent client-side no-op is also possible if the button was already disabled or non-functional by design; verify manually.',
        });
      } else {
        ctx.onLog(`[DataIntegrity] "${label}" triggered no same-origin POST/PUT/PATCH — likely a client-side-only action or a request to a different origin; nothing to correlate`);
      }
      return;
    }

    if (failedResponse && successText && !errorText) {
      ctx.onFinding({
        severity: 'high',
        area: 'UI-DataIntegrity',
        title: `"${label}" shows a success message despite a failed backend request`,
        steps: [`Open ${page.url()}`, `Click "${label}"`, 'Observe the confirmation message shown'],
        expected: 'The UI should not confirm success when the underlying request failed',
        actual: `UI showed: "${successText}" — but ${failedResponse.url} responded with HTTP ${failedResponse.status}`,
        evidence: [await shot(page, ctx, 'false-success')].filter((x): x is string => !!x),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
        confidence: 'verified',
        confidenceReason: 'Directly correlates the real HTTP response status against the actual visible confirmation text for the same action — not inferred.',
      });
      return;
    }

    if (okResponse && errorText && !successText) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-DataIntegrity',
        title: `"${label}" shows an error message despite a successful backend request`,
        steps: [`Open ${page.url()}`, `Click "${label}"`, 'Observe the message shown'],
        expected: 'The UI should not show an error when the underlying request actually succeeded — a user may retry or abandon something that already went through',
        actual: `UI showed: "${errorText}" — but ${okResponse.url} responded with HTTP ${okResponse.status}`,
        evidence: [await shot(page, ctx, 'false-error')].filter((x): x is string => !!x),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
        confidence: 'heuristic',
        confidenceReason: 'The visible error text may be an unrelated pre-existing validation message rather than genuinely caused by this submission — verify the request/response pair before treating as confirmed.',
      });
      return;
    }

    if (zeroFeedback) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-DataIntegrity',
        title: `"${label}" produces no visible feedback despite a backend request`,
        steps: [`Open ${page.url()}`, `Click "${label}"`, 'Observe the page for any confirmation, error, or navigation'],
        expected: 'A user-visible confirmation, error, or state change after an action that hits the backend',
        actual: `${responses[0]?.url ?? 'a request'} responded with HTTP ${responses[0]?.status ?? '?'}, but no success/error message, URL change, or on-page text change followed — a user cannot tell whether the action succeeded`,
        evidence: [await shot(page, ctx, 'zero-feedback-after-request')].filter((x): x is string => !!x),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
        confidence: 'heuristic',
        confidenceReason: 'Based on a coarse before/after content and URL diff — feedback rendered outside normal text flow (e.g. a subtle icon-only state change) would not be detected; verify manually.',
      });
      return;
    }

    // Checklist (UI) §27 — "API response → correct UI data." Distinct from the success/error
    // text correlation above: this checks that a SPECIFIC value from the response body actually
    // shows up on screen, not just that SOME positive feedback appeared — catching a UI that
    // shows a generic "Saved!" toast while silently rendering stale/placeholder data instead of
    // what the backend actually returned.
    if (okResponse?.body) {
      try {
        const parsed = JSON.parse(okResponse.body);
        const candidates = [parsed, parsed?.data, parsed?.result].filter((o) => o && typeof o === 'object');
        let distinctiveValue: string | null = null;
        for (const obj of candidates) {
          for (const v of Object.values(obj as Record<string, unknown>)) {
            if (typeof v === 'string' && v.length >= 6 && v.length <= 100 && !/^[0-9a-f-]{8,}$/i.test(v)) {
              distinctiveValue = v;
              break;
            }
          }
          if (distinctiveValue) break;
        }
        if (distinctiveValue) {
          await page.waitForTimeout(300);
          const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          if (!bodyText.includes(distinctiveValue)) {
            ctx.onLog(`[DataIntegrity] "${label}": response contains "${distinctiveValue.slice(0, 40)}" but it doesn't appear anywhere on the page afterward — could mean the UI isn't rendering the real response (not flagged: this field may simply not be display-relevant, e.g. an internal id or timestamp)`);
          } else {
            ctx.onLog(`[DataIntegrity] "${label}": response data correctly reflected in the rendered page`);
          }
        }
      } catch {
        /* response wasn't JSON, or had no suitable string field — nothing to compare */
      }
    }

    ctx.onLog(`[DataIntegrity] "${label}": ${responses.length} request(s), consistent UI feedback — no mismatch detected`);
  } finally {
    page.off('response', onResponse);
  }
}
