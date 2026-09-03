import { statSync } from 'node:fs';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runDownloadVerification(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[Download] Looking for download links/buttons to verify');

  const candidates = page.locator(
    'a[download], a[href$=".pdf"], a[href$=".csv"], a[href$=".zip"], a[href$=".xlsx"], ' +
      'button:has-text("Download"), button:has-text("Export"), a:has-text("Download"), a:has-text("Export")',
  );
  const count = await candidates.count().catch(() => 0);
  if (count === 0) {
    ctx.onLog('[Download] No download-triggering elements found');
    return;
  }

  const target = candidates.first();
  const label =
    (await target.textContent().catch(() => ''))?.trim().slice(0, 40) ||
    (await target.getAttribute('href').catch(() => '')) ||
    'download element';

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      target.click({ timeout: 3000 }),
    ]);
    const failure = await download.failure().catch(() => null);

    if (failure) {
      ctx.onFinding({
        severity: 'high',
        area: 'UI-Download',
        title: `Download failed: "${label}"`,
        steps: [`Open ${page.url()}`, `Click "${label}"`],
        expected: 'Clicking a download control produces a valid downloaded file',
        actual: `Download failed: ${failure}`,
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: page.url(),
      });
      return;
    }

    const path = await download.path().catch(() => null);
    if (path) {
      const size = statSync(path).size;
      if (size === 0) {
        ctx.onFinding({
          severity: 'high',
          area: 'UI-Download',
          title: `Download produces an empty (0-byte) file: "${label}"`,
          steps: [`Open ${page.url()}`, `Click "${label}"`, 'Check the downloaded file size'],
          expected: 'Downloaded file has real content',
          actual: 'Downloaded file is 0 bytes',
          evidence: [],
          reproRate: '1/1',
          automationCandidate: true,
          pageUrl: page.url(),
        });
        return;
      }
      ctx.onLog(`[Download] "${label}" downloaded successfully (${size} bytes)`);
    }
  } catch (err) {
    ctx.onLog(
      `[Download] No download event fired within 10s after clicking "${label}" (${(err as Error).message.slice(0, 100)}) ` +
        '— may open in a new tab/viewer instead of downloading, not necessarily a bug',
    );
  }
}
