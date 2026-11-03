import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { isLoginWallPage } from './helpers.js';
import { detectListItems, sameOriginRoutes, snap } from './list-items.js';

// A20 — Duplicate item images. broken-images.ts only catches images that FAIL to load. An
// image that loads fine but is the wrong one — every product showing the same photo, a stale
// thumbnail copied across a grid — is invisible to it and was previously only catchable by
// the optional AI visual review. Different items in one list sharing one image source is a
// cheap, rule-based signal for exactly that, with no AI key needed. Shared placeholder art
// ("no image available") is a deliberate pattern and is excluded by filename.

const PLACEHOLDER_SRC = /placeholder|no[-_]?image|noimage|default|blank|missing|spacer|transparent|fallback/i;

export async function runDuplicateImages(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  const pages = [page.url(), ...sameOriginRoutes(ctx, page.url(), 3)];
  let listsChecked = 0;

  for (const url of pages) {
    if (url !== page.url()) {
      const ok = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(800);
    }
    if (await isLoginWallPage(page)) continue;
    const list = await detectListItems(page);
    if (!list) continue;
    const withImg = list.items.filter((i) => i.imgSrc && !i.imgSrc.startsWith('data:'));
    if (withImg.length < 3) continue;
    listsChecked++;

    const bySrc = new Map<string, string[]>();
    for (const it of withImg) {
      const key = it.imgSrc!.split('?')[0];
      if (!bySrc.has(key)) bySrc.set(key, []);
      bySrc.get(key)!.push(it.name);
    }

    for (const [src, names] of bySrc) {
      const distinctNames = [...new Set(names)];
      if (distinctNames.length < 3) continue;
      if (PLACEHOLDER_SRC.test(src)) {
        ctx.onLog(`[DuplicateImages] ${distinctNames.length} items share a placeholder image (${src}) — treated as intentional`);
        continue;
      }
      const share = distinctNames.length / withImg.length;
      ctx.onFinding({
        severity: share >= 0.5 ? 'medium' : 'low',
        area: 'UI-Images',
        title: `${distinctNames.length} different items show the same image`,
        steps: [`Open ${page.url()}`, 'Compare the pictures of the items in the list'],
        expected: 'Each item shows its own image',
        actual: `${distinctNames.length} of ${withImg.length} items (${distinctNames.slice(0, 4).map((n) => `"${n}"`).join(', ')}${distinctNames.length > 4 ? ', …' : ''}) all load ${src}`,
        evidence: await snap(page, ctx, 'duplicate-images'),
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
        confidence: 'heuristic',
        confidenceReason: 'Identical image URL across differently-named items; a site that deliberately reuses one generic image would also trip this.',
      });
    }
  }
  if (listsChecked === 0) ctx.onLog('[DuplicateImages] No list of items with images found — nothing to compare');
}
