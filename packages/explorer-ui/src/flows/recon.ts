import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask, SiteIntelligenceSignals } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';

export async function collectIntelligenceSignals(page: Page): Promise<SiteIntelligenceSignals> {
  return page.evaluate(() => {
    const text = (selector: string): string[] =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => (el as HTMLElement).innerText?.trim())
        .filter(Boolean)
        .slice(0, 20);

    const title = document.title ?? '';
    const metaDesc =
      (document.querySelector('meta[name="description"]') as HTMLMetaElement)?.content ?? '';
    const headings = text('h1, h2, h3').slice(0, 10);

    const linkTexts = Array.from(document.querySelectorAll('a'))
      .map((a) => a.innerText.trim())
      .filter((t) => t.length > 0 && t.length < 60)
      .slice(0, 30);

    const buttonTexts = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="submit"]'),
    )
      .map((el) => (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || '')
      .filter(Boolean)
      .slice(0, 20);

    const inputTypes = Array.from(document.querySelectorAll('input'))
      .map((i) => i.type || 'text')
      .filter(Boolean);

    const urlPaths = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => {
        try {
          return new URL((a as HTMLAnchorElement).href).pathname;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .slice(0, 30);

    const textSample = (document.body?.innerText ?? '').slice(0, 1000).replace(/\s+/g, ' ');

    return {
      title,
      metaDescription: metaDesc,
      headings,
      linkTexts,
      buttonTexts,
      inputTypes,
      urlPaths,
      textSample,
    };
  });
}

export async function runRecon(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  const apiCalls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (
      req.resourceType() === 'xhr' ||
      req.resourceType() === 'fetch' ||
      url.includes('/api/')
    ) {
      apiCalls.push(`${req.method()} ${url}`);
    }
  });

  // Wait for the app to fully settle (networkidle) BEFORE reading links/forms/title —
  // client-rendered SPAs routinely have zero real nav links in the DOM at
  // domcontentloaded time, so counting immediately produces a false "no links found"
  // finding on a page that hasn't finished rendering yet, not a real bug.
  await page.reload({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

  const title = await page.title();

  const links = await page.$$eval('a[href]', (els) =>
    els
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith('http'))
      .slice(0, 20),
  );

  const forms = await page.$$eval('form', (els) =>
    els.slice(0, 5).map((f) => ({
      action: (f as HTMLFormElement).action || '',
      method: (f as HTMLFormElement).method || 'get',
      fields: Array.from(f.querySelectorAll('input, select, textarea')).map(
        (el) => (el as HTMLInputElement).name || (el as HTMLInputElement).type || 'unknown',
      ),
    })),
  );

  const hasLoginWall =
    (await page.locator('input[type="password"]').count()) > 0 &&
    ctx.config.credentials?.type === 'none';

  const screenshotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'recon.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  ctx.onLog(
    `[Recon] "${title}" — ${links.length} links, ${forms.length} forms, ${apiCalls.length} API calls`,
  );

  // Distinct routes (origin+pathname) discovered from landing-page links — the "what SHOULD
  // get covered" half of the coverage-report flow's comparison. Query strings/fragments are
  // stripped since they don't represent a genuinely different page for coverage purposes.
  // Same-origin only — an external link (a partner site, app store badge, docs site) isn't a
  // route of the app under test, and flagging it "not visited" would be a false gap, not real
  // missing coverage.
  const targetOrigin = (() => {
    try {
      return new URL(ctx.config.targetUrl).origin;
    } catch {
      return null;
    }
  })();
  const discoveredRoutes = [
    ...new Set(
      links
        .map((href) => {
          try {
            const u = new URL(href);
            if (targetOrigin && u.origin !== targetOrigin) return null;
            return u.origin + u.pathname;
          } catch {
            return null;
          }
        })
        .filter((r): r is string => r !== null),
    ),
  ];
  if (discoveredRoutes.length > 0) {
    ctx.discoveredRoutes = discoveredRoutes;
  }

  // Share discovered API endpoints with the context so the API executor uses
  // real endpoints instead of guessing generic paths like /api/users, /api/admin
  if (apiCalls.length > 0) {
    ctx.discoveredApiEndpoints = apiCalls;
    ctx.onLog(`[Recon] Sharing ${apiCalls.length} real API endpoints with API executor`);
  }

  // Collect signals and notify orchestrator for classification. Awaited because the
  // orchestrator's handler may call out to an LLM for classification before falling back
  // to the deterministic rule set — recon is a one-shot early task, so it's the right place
  // to absorb that extra latency rather than letting later tasks race ahead of a classification
  // that hasn't landed yet.
  if (ctx.onClassification) {
    const signals = await collectIntelligenceSignals(page);
    // onClassification is wired by the orchestrator which has access to classifySite
    // We pass signals via a synthetic "signals" classification call
    await ctx.onClassification({ siteType: 'generic', confidence: 0, signals: [], inferredJourneys: [], keyFeatures: [], _rawSignals: signals } as unknown as import('@qa/shared').SiteClassification);
  }

  if (hasLoginWall) {
    ctx.onFinding({
      severity: 'info',
      area: 'UI-Recon',
      title: 'Login wall detected — credentials may be required',
      steps: ['Navigate to target URL', 'Observe login form'],
      expected: 'Public access or provided credentials',
      actual: 'Password field found without credentials configured',
      evidence: [screenshotPath],
      reproRate: '1/1',
      automationCandidate: false,
    });
  }

  // Login/auth walls intentionally have no nav links — suppress false positives
  const onLoginWall = await isLoginWallPage(page);

  if (links.length === 0 && !onLoginWall) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-Recon',
      title: 'No navigable links found on landing page',
      steps: ['Load landing page', 'Scan for anchor tags'],
      expected: 'At least some navigation links',
      actual: 'Zero http links discovered',
      evidence: [screenshotPath],
      reproRate: '1/1',
      automationCandidate: false,
    });
  } else if (links.length === 0 && onLoginWall) {
    ctx.onLog('[Recon] No nav links found but page is a login wall — expected, skipping finding');
  }
}
