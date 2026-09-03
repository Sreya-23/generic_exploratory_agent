import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';
import { waitForRealContent } from './helpers.js';

function luminance(rgb: string): number | null {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export async function runDarkModeCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[DarkMode] Checking whether the page responds to prefers-color-scheme: dark');
  const originalUrl = page.url();

  const lightBg = await page
    .evaluate(() => window.getComputedStyle(document.body).backgroundColor)
    .catch(() => '');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await waitForRealContent(page);

  const darkBg = await page
    .evaluate(() => window.getComputedStyle(document.body).backgroundColor)
    .catch(() => '');
  const darkColor = await page
    .evaluate(() => window.getComputedStyle(document.body).color)
    .catch(() => '');

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'dark-mode.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  if (lightBg && darkBg && lightBg === darkBg) {
    // Simply NOT implementing dark mode isn't a defect — most real-world sites don't, and
    // treating "doesn't have this feature" as a bug on nearly every site tested is noise, not
    // signal. Only actually broken dark-mode behavior (the contrast-collapse branch below) is
    // worth a finding; a site that never attempted dark mode at all just gets a log line.
    ctx.onLog(`[DarkMode] Page does not implement prefers-color-scheme: dark (background stayed "${lightBg}") — not flagged, most sites don't support this`);
  } else {
    const bgLum = luminance(darkBg);
    const textLum = luminance(darkColor);
    if (bgLum !== null && textLum !== null && Math.abs(bgLum - textLum) < 0.15) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-DarkMode',
        title: 'Base text/background contrast collapses under dark mode',
        steps: [`Open ${originalUrl}`, 'Set the OS/browser to dark mode', 'Reload the page'],
        expected: 'Dark mode should keep readable contrast between page text and background',
        actual: `Body background "${darkBg}" and text "${darkColor}" are too close in luminance to read comfortably`,
        evidence: [shot],
        reproRate: '1/1',
        automationCandidate: true,
        pageUrl: originalUrl,
      });
    } else {
      ctx.onLog('[DarkMode] Page responds to dark mode with reasonable base contrast');
    }
  }

  await page.emulateMedia({ colorScheme: null }).catch(() => {});
}
