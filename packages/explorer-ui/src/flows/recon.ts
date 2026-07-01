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

  await page.reload({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

  const hasLoginWall =
    (await page.locator('input[type="password"]').count()) > 0 &&
    ctx.config.credentials?.type === 'none';

  const screenshotPath = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'recon.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  ctx.onLog(
    `[Recon] "${title}" — ${links.length} links, ${forms.length} forms, ${apiCalls.length} API calls`,
  );

  // Collect signals and notify orchestrator for classification
  if (ctx.onClassification) {
    const signals = await collectIntelligenceSignals(page);
    // onClassification is wired by the orchestrator which has access to classifySite
    // We pass signals via a synthetic "signals" classification call
    ctx.onClassification({ siteType: 'generic', confidence: 0, signals: [], inferredJourneys: [], keyFeatures: [], _rawSignals: signals } as unknown as import('@qa/shared').SiteClassification);
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
