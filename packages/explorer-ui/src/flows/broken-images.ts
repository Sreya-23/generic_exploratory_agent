import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// naturalWidth === 0 on a loaded <img> is the browser's own, unambiguous signal that the
// image failed to decode (404, broken URL, corrupt file, CORS block) — not a heuristic guess.
export async function runBrokenImagesCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[BrokenImages] Scanning <img> elements for failed loads');

  // Give lazy-loaded/late-appearing images a moment to actually attempt their fetch.
  await page.waitForTimeout(1000);

  const broken = await page
    .evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const results: { src: string; alt: string }[] = [];
      for (const img of imgs) {
        const el = img as HTMLImageElement;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (!el.src) continue;
        // complete===true but naturalWidth===0 is exactly the "tried to load, failed" state —
        // an image that's simply still loading has complete===false and isn't flagged.
        if (el.complete && el.naturalWidth === 0) {
          results.push({ src: el.src.slice(0, 200), alt: el.alt || '(no alt text)' });
        }
      }
      return results.slice(0, 15);
    })
    .catch(() => [] as { src: string; alt: string }[]);

  // Background-images declared via CSS don't expose naturalWidth — check whether their URL
  // actually resolves instead.
  const bgImageUrls = await page
    .evaluate(() => {
      const urls = new Set<string>();
      const all = Array.from(document.querySelectorAll('body *')).slice(0, 1500);
      for (const el of all) {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const bg = style.backgroundImage;
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1] && !match[1].startsWith('data:')) urls.add(match[1]);
      }
      return [...urls].slice(0, 10);
    })
    .catch(() => [] as string[]);

  const brokenBgImages: string[] = [];
  for (const url of bgImageUrls) {
    try {
      const resolved = new URL(url, page.url()).toString();
      const response = await page.request.get(resolved, { timeout: 5000 }).catch(() => null);
      if (response && !response.ok()) {
        brokenBgImages.push(`${url} (HTTP ${response.status()})`);
      }
    } catch {
      // Unresolvable/relative-URL edge case — skip rather than false-flag.
    }
  }

  if (broken.length === 0 && brokenBgImages.length === 0) {
    ctx.onLog('[BrokenImages] No broken images found');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'broken-images.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  if (broken.length > 0) {
    ctx.onFinding({
      severity: 'medium',
      area: 'UI-BrokenImages',
      title: `${broken.length} <img> element(s) failed to load`,
      steps: [`Open ${page.url()}`, 'Open DevTools → Network, filter by Img, reload'],
      expected: 'Every rendered <img> successfully loads its source',
      actual: `Failed to load: ${broken.map((b) => `"${b.alt}" (${b.src})`).join('; ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'naturalWidth===0 on a completed <img> load is an unambiguous browser-native signal, not a heuristic.',
    });
  }

  if (brokenBgImages.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-BrokenImages',
      title: `${brokenBgImages.length} CSS background-image URL(s) return an error`,
      steps: [`Open ${page.url()}`, 'Check computed background-image URLs in DevTools'],
      expected: 'Every CSS background-image resolves successfully',
      actual: `Failed: ${brokenBgImages.join('; ')}`,
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Direct HTTP request to the background-image URL returned a non-OK status.',
    });
  }
}
