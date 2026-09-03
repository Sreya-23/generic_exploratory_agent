// AI-powered visual QA — the one class of bug every other flow in this codebase is
// structurally blind to: things that are wrong in the RENDERED IMAGE, not in any DOM
// property, computed style, or measurable geometry. Overlapping text, a modal genuinely
// off-screen despite passing isVisible(), leftover "Lorem ipsum" placeholder copy, an icon
// font that failed to load and shows a box glyph instead — none of these produce a
// detectable DOM/CSS signal, only a visual one a human (or a vision model) can actually see.
//
// This is deliberately a pure ADDITION, never a replacement: every other flow in this
// codebase runs unconditionally regardless of whether Gemini is configured or reachable.
// If GEMINI_API_KEY is unset, or the API call fails for ANY reason (bad key, rate limit,
// network error, malformed response), this flow logs it and returns — it never throws,
// never blocks, and never affects any other task in the session.
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask, Severity } from '@qa/shared';
import { waitForRealContent, isLoginWallPage } from './helpers.js';

// Reads a cheap, coarse "content shape" signal — not proof the page is done loading, but
// enough to tell whether it's still actively changing right now. Used by waitForStableContent
// below to avoid screenshotting a page mid-transition (the exact failure mode that produced
// the "empty white dashboard" misread — a real, but still-loading, skeleton state).
async function contentShapeSignal(page: Page): Promise<string> {
  return page
    .evaluate(() => `${(document.body?.innerText ?? '').trim().length}|${document.querySelectorAll('button, a[href], input, select').length}`)
    .catch(() => '');
}

// A self-check before spending the one billed Gemini call: sample the content shape twice,
// 1.2s apart. If it's still changing, wait a bit longer (bounded) rather than screenshot a
// page that's mid-transition — this is what would have caught the empty-dashboard misread
// automatically, without needing a second (costly) AI call to verify after the fact.
async function waitForStableContent(page: Page, maxWaitMs = 4000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let last = await contentShapeSignal(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1200);
    const current = await contentShapeSignal(page);
    if (current === last) return;
    last = current;
  }
}

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Latency observed ranges from ~5-6s up to 35s+ across real calls (this model does
// internal "thinking" before responding, with real variance) — generous enough to not
// falsely abort a slow-but-fine response, still bounded so a genuinely hung request
// doesn't stall the session for too long.
const REQUEST_TIMEOUT_MS = 50000;

const VISUAL_REVIEW_PROMPT = `You are a QA engineer reviewing a screenshot of a real web application for VISUAL bugs — issues visible in the rendered image that would not show up by inspecting HTML/CSS values. Look specifically for:

1. Overlapping or colliding text/elements
2. Text clipped, cut off, or truncated unexpectedly
3. Misaligned layout (inconsistent spacing, uneven grid/card heights, off-center elements)
4. Images that appear broken, stretched, distorted, or show a placeholder instead of real content
5. Text that is hard to read against its background (poor contrast in practice, not just by the numbers)
6. Broken visual states (a disabled-looking button that isn't actually disabled, a stuck loading spinner)
7. Unstyled content suggesting a stylesheet failed to load
8. Elements positioned off-screen, clipped by a parent container, or rendered behind another element
9. Inconsistent design (mismatched button styles/fonts within the same view)
10. Leftover placeholder/dev content — ONLY unambiguous markers: literal "Lorem ipsum", "TODO"/"FIXME", unresolved double-curly-brace or dollar-brace template syntax, or a value that is literally the word "test"/"placeholder"/"undefined"/"null" where real content should be. Do NOT flag real-looking data just because it looks short, unusual, or unfamiliar to you (e.g. a person's name, a group/team name, an internal code) — you cannot tell fake data from real data by vibes alone, only by these concrete unresolved-template/placeholder-literal signals.
11. Layout issues suggesting broken RTL/i18n handling (mirrored icons, misaligned translated text)
12. Charts/graphs that render empty, garbled, or with overlapping labels
13. Icon glyphs rendering as a box/question-mark (icon font failed to load)

Only report things you can actually SEE going wrong in this specific image — do not guess at things you cannot verify visually, and do not report normal, correctly-rendered content. In particular, do NOT flag any of these common, DELIBERATE product patterns as "failed to render" or "empty page" as long as their own content is actually visible: a "please download our mobile app" interstitial (icon, short message, Play Store/App Store badges); a cookie-consent banner; a maintenance/"be right back" page; or an empty-state placeholder ("no results found", "nothing here yet"). A mostly-white or sparse layout with real, legible content is not the same as a failed render — only flag it if you can point to something concrete that is missing, broken, or garbled, not just "this looks empty."

Do NOT flag a pagination or range indicator — text like "1-5 of 18", "1 - 5 / 18 Groups", "Page 1 of 4" — as truncated, cut-off, or incomplete content, even when it sits next to a small arrow/chevron control. That is a standard, deliberate paging pattern: the arrow is how a user sees the remaining items, not evidence that content failed to load. You cannot tell from a static screenshot alone whether that arrow is functional, so do not guess that it isn't — only flag it if something about its own rendering is visibly broken (e.g. the arrow icon itself is a broken box glyph).

You may be given more than one screenshot in this request, each preceded by a line reading "--- SCREENSHOT N — page: <url> ---". Review every screenshot independently against the same categories above. Respond with ONLY a JSON array (no markdown fences, no commentary) covering issues found across ALL screenshots combined, each element shaped as:
{"page": "<the exact url from the SCREENSHOT label this issue was found on>", "issue": "<specific, concrete description of what's wrong and where in the image>", "severity": "low"|"medium"|"high"}
If you find nothing wrong in any screenshot, respond with exactly: []`;

interface VisualIssue {
  page?: string;
  issue: string;
  severity: string;
}

function extractJsonArray(text: string): VisualIssue[] {
  // Models occasionally wrap JSON in markdown fences or add stray text around it despite
  // instructions not to — pull out just the array rather than trusting the whole response
  // to be clean JSON.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is VisualIssue =>
        item && typeof item === 'object' && typeof item.issue === 'string',
    );
  } catch {
    return [];
  }
}

function normalizeSeverity(raw: string): Severity {
  const s = raw.toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'low';
}

// ── Usage controls — this is a real, billable API call, and running many sessions back to
// back (routine while iterating on this agent) can otherwise burn quota fast for very
// little new signal, since a site's UI doesn't visually change between two runs minutes
// apart. All limits are checked BEFORE the API call, so a skip here costs nothing.
const DAILY_CALL_LIMIT = Number(process.env.GEMINI_VISUAL_REVIEW_DAILY_LIMIT ?? 15);
const COOLDOWN_HOURS = Number(process.env.GEMINI_VISUAL_REVIEW_COOLDOWN_HOURS ?? 6);
// Smoke/chaos depth is meant to be a fast, cheap sanity pass — an AI call doesn't belong
// there. Only standard/deep runs (the ones you'd actually review a full report from) spend
// the quota.
const ELIGIBLE_DEPTHS = new Set(['standard', 'deep']);

interface UsageTracker {
  dateKey: string;
  callsToday: number;
  lastReviewByOrigin: Record<string, string>; // origin -> ISO timestamp
}

function usageTrackerPath(ctx: ExecutorContext): string {
  return join(ctx.sessionsDir, '.gemini-visual-review-usage.json');
}

function loadUsageTracker(ctx: ExecutorContext): UsageTracker {
  const path = usageTrackerPath(ctx);
  const todayKey = new Date().toISOString().slice(0, 10);
  try {
    if (!existsSync(path)) return { dateKey: todayKey, callsToday: 0, lastReviewByOrigin: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as UsageTracker;
    // Roll over to a fresh daily count once the calendar day changes — the per-origin
    // cooldown map persists regardless, since that's about UI staleness, not a daily quota.
    if (parsed.dateKey !== todayKey) return { dateKey: todayKey, callsToday: 0, lastReviewByOrigin: parsed.lastReviewByOrigin ?? {} };
    return { dateKey: parsed.dateKey, callsToday: parsed.callsToday ?? 0, lastReviewByOrigin: parsed.lastReviewByOrigin ?? {} };
  } catch {
    // Corrupt/unreadable tracker — reset rather than get permanently stuck skipping.
    return { dateKey: todayKey, callsToday: 0, lastReviewByOrigin: {} };
  }
}

function saveUsageTracker(ctx: ExecutorContext, tracker: UsageTracker): void {
  try {
    writeFileSync(usageTrackerPath(ctx), JSON.stringify(tracker, null, 2));
  } catch {
    /* best-effort — a failed write just means the next call re-derives from scratch */
  }
}

export async function runVisualReview(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    ctx.onLog('[VisualReview] GEMINI_API_KEY not configured — skipping AI visual review (all other checks unaffected)');
    return;
  }

  if (!ELIGIBLE_DEPTHS.has(ctx.config.depth)) {
    ctx.onLog(`[VisualReview] Skipping at "${ctx.config.depth}" depth — AI visual review only runs at standard/deep`);
    return;
  }

  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return page.url();
    }
  })();
  const tracker = loadUsageTracker(ctx);

  if (tracker.callsToday >= DAILY_CALL_LIMIT) {
    ctx.onLog(`[VisualReview] Daily Gemini call limit reached (${DAILY_CALL_LIMIT}) — skipping to protect quota`);
    return;
  }

  const lastReviewed = tracker.lastReviewByOrigin[origin];
  if (lastReviewed) {
    const hoursSince = (Date.now() - new Date(lastReviewed).getTime()) / (1000 * 60 * 60);
    if (hoursSince < COOLDOWN_HOURS) {
      ctx.onLog(
        `[VisualReview] ${origin} was already reviewed ${hoursSince.toFixed(1)}h ago ` +
          `(cooldown: ${COOLDOWN_HOURS}h) — skipping, UI is unlikely to have changed`,
      );
      return;
    }
  }

  try {
    await waitForStableContent(page);
    const pageUrl = page.url();
    // If auth was expected (credentials configured) but this page is still a login/OTP wall,
    // the login for THIS session likely never completed — anything found here could be a real
    // defect on the login page itself, or just an artifact of testing an unauthenticated stub.
    // Surfaced as an extra confidence caveat rather than skipped outright, since real bugs
    // (e.g. a blank country-code selector) have genuinely been found this way before.
    const onLoginWall =
      ctx.config.credentials?.type && ctx.config.credentials.type !== 'none'
        ? await isLoginWallPage(page).catch(() => false)
        : false;
    const shotDir = join(ctx.sessionsDir, ctx.sessionId, 'screenshots');
    const primaryShotPath = join(shotDir, 'visual-review-primary.png');
    // fullPage (not just the visible viewport) — same one API call, but Gemini sees
    // everything a user would hit by scrolling, not just what's above the fold.
    const primaryBuffer = await page.screenshot({ path: primaryShotPath, fullPage: true });
    const images: Array<{ url: string; base64: string; shotPath: string }> = [
      { url: pageUrl, base64: primaryBuffer.toString('base64'), shotPath: primaryShotPath },
    ];

    // Bundle a second, genuinely different page into the SAME billed call when one is cheaply
    // available: the session's original entry URL (often the pre-auth login/landing page)
    // usually differs from wherever the executor has since navigated to (e.g. the
    // authenticated dashboard) — reviewing both costs nothing extra since Gemini vision
    // accepts multiple images per request, but doubles the surface actually inspected.
    try {
      const entryUrl = ctx.config.targetUrl;
      const currentKey = new URL(pageUrl).origin + new URL(pageUrl).pathname;
      const entryKey = new URL(entryUrl).origin + new URL(entryUrl).pathname;
      if (entryKey !== currentKey) {
        const secondaryPage = await page.context().newPage();
        try {
          await secondaryPage.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await waitForRealContent(secondaryPage);
          const resolvedUrl = secondaryPage.url();
          // If the entry URL redirects back to the same page we already have (e.g. /login
          // bouncing to /dashboard because the session is already authenticated), skip it —
          // no point spending review attention on a duplicate screenshot.
          if (resolvedUrl !== pageUrl) {
            const secondaryShotPath = join(shotDir, 'visual-review-secondary.png');
            const secondaryBuffer = await secondaryPage.screenshot({
              path: secondaryShotPath,
              fullPage: true,
            });
            images.push({
              url: resolvedUrl,
              base64: secondaryBuffer.toString('base64'),
              shotPath: secondaryShotPath,
            });
          }
        } finally {
          await secondaryPage.close().catch(() => {});
        }
      }
    } catch {
      // The second page is a bonus, not a requirement — fall through with just the primary
      // screenshot if the entry URL can't be reached for any reason.
    }

    ctx.onLog(
      `[VisualReview] Sending ${images.length} screenshot(s) (${images.map((i) => i.url).join(', ')}) ` +
        `to Gemini for visual QA review (${tracker.callsToday + 1}/${DAILY_CALL_LIMIT} today)`,
    );
    // Record usage now, right as the call is committed — this is what's actually billed,
    // so it counts against quota even if the response later fails to parse. Still exactly
    // one call regardless of how many images are bundled into it.
    tracker.callsToday += 1;
    tracker.lastReviewByOrigin[origin] = new Date().toISOString();
    saveUsageTracker(ctx, tracker);

    const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
      { text: VISUAL_REVIEW_PROMPT },
    ];
    images.forEach((img, i) => {
      parts.push({ text: `--- SCREENSHOT ${i + 1} — page: ${img.url} ---` });
      parts.push({ inline_data: { mime_type: 'image/png', data: img.base64 } });
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ contents: [{ parts }] }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      ctx.onLog(`[VisualReview] Gemini API returned ${response.status} — skipping this pass. ${errBody.slice(0, 200)}`);
      return;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? '';
    const issues = extractJsonArray(text);

    if (issues.length === 0) {
      ctx.onLog(`[VisualReview] No visual issues found across ${images.length} reviewed page(s)`);
      return;
    }

    for (const item of issues) {
      const matched =
        images.find((img) => item.page && img.url === item.page) ??
        images.find((img) => item.page && (img.url.includes(item.page) || item.page.includes(img.url))) ??
        images[0];
      ctx.onFinding({
        severity: normalizeSeverity(item.severity),
        area: 'UI-Visual',
        title: `Visual issue: ${item.issue.slice(0, 80)}`,
        steps: [`Open ${matched.url}`, 'Visually inspect the rendered page'],
        expected: 'No visual rendering defects',
        actual: item.issue,
        evidence: [matched.shotPath],
        reproRate: '1/1',
        automationCandidate: false,
        pageUrl: matched.url,
        confidence: 'heuristic',
        confidenceReason:
          'Single AI-vision read of one screenshot, not cross-validated against a second signal — check the attached screenshot before treating as confirmed.' +
          (onLoginWall
            ? ' This session may not have completed login — verify this issue reproduces with a genuinely authenticated session, not just an auth-wall stub.'
            : ''),
      });
    }

    ctx.onLog(`[VisualReview] Found ${issues.length} visual issue(s) via AI review`);
  } catch (err) {
    // Network failure, timeout, malformed response — any of these should skip this ONE
    // flow, never affect the rest of the session.
    ctx.onLog(`[VisualReview] Gemini visual review failed (${(err as Error).message.slice(0, 150)}) — skipping`);
  }
}
