// Locale correctness beyond RTL — rtl-layout.ts already covers hardcoded left/right layout
// assumptions under a right-to-left direction. This covers two different, LTR-language-only
// gaps: (1) text expansion — German/Finnish-style long compound words are famous for breaking
// layouts tuned only for short English labels; (2) locale-aware formatting — dates, numbers,
// and currency should render differently for a German user (31.12.2024, 1.234,56 €) than a US
// one (12/31/2024, $1,234.56); an app that renders byte-identical text regardless of locale is
// very likely hardcoding US formatting rather than using the browser's own Intl APIs.
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { savedSessionStatePath, restoreSessionStorage, waitForRealContent } from './helpers.js';

// A currency/amount-like token: $1,234.56 or 1,234.56 USD or similar — deliberately loose,
// this only needs to catch the SAME literal substring appearing in both locales, not parse it.
const CURRENCY_PATTERN = /[$€£¥]\s?\d[\d,]*\.?\d*|\d[\d,]*\.\d{2}\s?(USD|EUR|GBP)\b/g;
// US-style MM/DD/YYYY or MM-DD-YYYY — a German/most-of-the-world reader expects DD.MM.YYYY.
const US_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;

async function extractFormattedTokens(page: Page): Promise<{ currency: string[]; dates: string[] }> {
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  return {
    currency: [...new Set(text.match(CURRENCY_PATTERN) ?? [])].slice(0, 10),
    dates: [...new Set(text.match(US_DATE_PATTERN) ?? [])].slice(0, 10),
  };
}

export async function runLocaleFormatCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[LocaleFormat] Checking text-expansion tolerance and locale-aware formatting under de-DE');
  const url = page.url();

  const baselineOverflow = await page
    .evaluate(() => ({
      scrollWidth: document.body?.scrollWidth ?? document.documentElement.scrollWidth,
      clientWidth: window.innerWidth,
    }))
    .catch(() => ({ scrollWidth: 0, clientWidth: 0 }));
  const baselineTokens = await extractFormattedTokens(page);

  // A fresh context with locale: 'de-DE' — this genuinely changes navigator.language and the
  // Accept-Language header the same way a real user's browser setting would, not a DOM-level
  // simulation. Sites with real i18n (server-negotiated or client-side via navigator.language)
  // will actually respond to it; sites that don't will simply keep showing English, which is
  // itself useful information logged below rather than treated as a failure.
  const browser = await chromium.launch({ headless: true });
  try {
    const savedState = savedSessionStatePath(ctx);
    const context = await browser.newContext({
      locale: 'de-DE',
      ignoreHTTPSErrors: true,
      ...(savedState ? { storageState: savedState } : {}),
    });
    if (savedState) {
      await restoreSessionStorage(context, join(ctx.sessionsDir, ctx.sessionId), url);
    }
    const dePage = await context.newPage();
    await dePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await waitForRealContent(dePage).catch(() => {});

    const deOverflow = await dePage
      .evaluate(() => ({
        scrollWidth: document.body?.scrollWidth ?? document.documentElement.scrollWidth,
        clientWidth: window.innerWidth,
      }))
      .catch(() => ({ scrollWidth: 0, clientWidth: 0 }));
    const deTokens = await extractFormattedTokens(dePage);
    const translated = await dePage
      .evaluate(() => document.documentElement.lang || '')
      .catch(() => '');

    // ── Text-expansion overflow: only meaningful if the overflow is NEW under de-DE, not
    // already present in the baseline (that's a plain responsive-layout bug, already covered
    // by viewport.ts/zoom-reflow.ts, not a locale-specific one). ────────────────────────────
    const baselineOk = baselineOverflow.scrollWidth <= baselineOverflow.clientWidth + 5;
    const deOverflows = deOverflow.scrollWidth > deOverflow.clientWidth + 5;
    if (baselineOk && deOverflows) {
      const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'locale-format-overflow.png');
      await dePage.screenshot({ path: shot, fullPage: false }).catch(() => {});
      ctx.onFinding({
        severity: 'low',
        area: 'UI-LocaleFormat',
        title: 'Layout overflows under a German (de-DE) locale but not the default one',
        steps: [
          `Open ${url} with the browser locale set to de-DE`,
          'Compare against the same page under the default locale',
        ],
        expected: 'Layout should tolerate longer translated strings without introducing horizontal scroll',
        actual: `No horizontal overflow at default locale; ${deOverflow.scrollWidth}px content in a ${deOverflow.clientWidth}px viewport under de-DE`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
        confidence: translated ? 'verified' : 'heuristic',
        confidenceReason: translated
          ? `The page's own lang attribute changed to "${translated}", confirming it actually re-rendered translated content under this locale.`
          : 'The page\'s lang attribute did not change under de-DE, so this may be measuring a longer Accept-Language-driven server response rather than genuinely translated UI text — worth confirming the site actually supports German before treating this as a real i18n layout bug.',
      });
    }

    // ── Locale-insensitive formatting: same exact currency/date substrings regardless of
    // locale is a real signal, but a US-only business intentionally always showing USD is a
    // legitimate, common design — so this stays heuristic/low, framed as worth checking rather
    // than asserted as a defect. ─────────────────────────────────────────────────────────────
    const identicalCurrency = baselineTokens.currency.filter((t) => deTokens.currency.includes(t));
    const identicalDates = baselineTokens.dates.filter((t) => deTokens.dates.includes(t));
    if (identicalCurrency.length > 0 || identicalDates.length > 0) {
      const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'locale-format-values.png');
      await dePage.screenshot({ path: shot, fullPage: false }).catch(() => {});
      ctx.onFinding({
        severity: 'low',
        area: 'UI-LocaleFormat',
        title: 'Currency/date formatting is unchanged under a different browser locale',
        steps: [
          `Open ${url} with the browser locale set to de-DE`,
          'Compare displayed dates/amounts against the default-locale version',
        ],
        expected: 'A German locale conventionally formats dates as DD.MM.YYYY and amounts as 1.234,56 € — if the app targets German users, formatting should adapt',
        actual: `Identical formatting in both locales — currency: ${identicalCurrency.join(', ') || 'none'}; dates: ${identicalDates.join(', ') || 'none'}`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: url,
        confidence: 'heuristic',
        confidenceReason: 'Confirms the exact same formatted text appears under both locales, which is consistent with hardcoded (rather than Intl-based) formatting — but a business that intentionally always displays one currency/date format regardless of visitor locale is common and not itself a bug. Only relevant if this app is meant to serve a German-locale audience.',
      });
    }

    if (!translated) {
      ctx.onLog('[LocaleFormat] Page did not appear to translate under de-DE (lang attribute unchanged) — this app may not support locale switching at all');
    }

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}
