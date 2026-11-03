// Per-HOSTNAME nav-structure memory across sessions — distinct from the per-CATEGORY
// `siteKnowledge` doc (site-knowledge-base.ts in agent-core), which is report-only and never
// changes exploration behavior. This one directly lets navigation.ts skip re-discovering a
// page's sub-links on a repeat crawl of the same site, instead of walking the whole thing again
// every single run. Lives alongside `sessions/` and `knowledge-base/` under the data root.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteCacheEntry } from '@qa/shared';

// Sites change — a structure map from months ago risks silently missing real navigation
// changes (a renamed/removed tab) rather than just wasting a little re-discovery time. 14 days
// balances "actually saves repeat-run time for an active target" against that risk.
const MAX_CACHE_AGE_MS = 1000 * 60 * 60 * 24 * 14;

function cachePath(siteCacheDir: string, hostname: string): string {
  // Hostnames are already a safe, simple filename alphabet (letters/digits/dots/hyphens) —
  // no sanitization needed.
  return join(siteCacheDir, `${hostname}.json`);
}

/**
 * Null when there's no cache yet for this hostname, or it's too stale to trust. `ignoreAge`
 * skips the staleness check — used when re-reading right before a write, to merge in whatever
 * older entries this run didn't itself touch rather than discarding them.
 */
export async function loadSiteCache(
  siteCacheDir: string,
  hostname: string,
  opts: { ignoreAge?: boolean } = {},
): Promise<SiteCacheEntry | null> {
  const path = cachePath(siteCacheDir, hostname);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(await readFile(path, 'utf-8')) as SiteCacheEntry;
    if (!opts.ignoreAge) {
      const age = Date.now() - new Date(entry.lastCrawledAt).getTime();
      if (!Number.isFinite(age) || age > MAX_CACHE_AGE_MS) return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function saveSiteCache(siteCacheDir: string, entry: SiteCacheEntry): Promise<void> {
  await mkdir(siteCacheDir, { recursive: true });
  await writeFile(cachePath(siteCacheDir, entry.hostname), JSON.stringify(entry, null, 2), 'utf-8');
}
