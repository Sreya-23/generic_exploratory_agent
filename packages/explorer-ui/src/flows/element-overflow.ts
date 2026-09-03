import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

// Page-level overflow (viewport.ts) only catches the whole document scrolling horizontally —
// it structurally cannot see a card, button, or label whose OWN text silently clips or
// overflows its box while the rest of the page looks fine. This walks individual
// text-bearing elements and checks each one's own content-vs-box relationship.
export async function runElementOverflowCheck(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[ElementOverflow] Scanning individual elements for clipped or overflowing text');

  const issues = await page
    .evaluate(() => {
      const results: { text: string; tag: string; kind: 'clipped' | 'overflowed' }[] = [];
      const all = Array.from(document.querySelectorAll('body *')).slice(0, 3000);

      for (const el of all) {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

        // Only elements whose OWN direct text (not a big wrapper's aggregated text) is what
        // we're measuring — avoids flagging a container just because a deeply nested child
        // overflows, which would be reported separately when we reach that child.
        const hasDirectText = Array.from(node.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
        );
        if (!hasDirectText) continue;

        const text = (node.textContent ?? '').trim();
        if (text.length === 0) continue;

        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // Silently clipped: overflow is hidden and content is wider/taller than the box, with
        // NO ellipsis or other truncation indicator — the text is just cut off mid-character
        // with nothing telling the user more content exists.
        const clipsOverflow = style.overflow === 'hidden' || style.overflowX === 'hidden';
        const hasEllipsis = style.textOverflow === 'ellipsis';
        const contentWider = node.scrollWidth > node.clientWidth + 2;
        const contentTaller = node.scrollHeight > node.clientHeight + 2;

        if (clipsOverflow && !hasEllipsis && (contentWider || contentTaller)) {
          results.push({ text: text.slice(0, 50), tag: node.tagName.toLowerCase(), kind: 'clipped' });
          continue;
        }

        // Overflowing its visible box entirely: overflow is visible (not clipped, not
        // scrollable) but content genuinely spills past the box edges into neighboring layout.
        if (style.overflow === 'visible' && (contentWider || contentTaller) && rect.width < 2000) {
          results.push({ text: text.slice(0, 50), tag: node.tagName.toLowerCase(), kind: 'overflowed' });
        }
      }
      return results.slice(0, 10);
    })
    .catch(() => [] as { text: string; tag: string; kind: 'clipped' | 'overflowed' }[]);

  if (issues.length === 0) {
    ctx.onLog('[ElementOverflow] No clipped or overflowing text found');
    return;
  }

  const shot = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', 'element-overflow.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  const clipped = issues.filter((i) => i.kind === 'clipped');
  const overflowed = issues.filter((i) => i.kind === 'overflowed');

  if (clipped.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ElementOverflow',
      title: `${clipped.length} element(s) silently clip text with no truncation indicator`,
      steps: [`Open ${page.url()}`, 'Inspect the elements listed below'],
      expected: 'Clipped text shows an ellipsis or other indicator that content continues',
      actual: clipped.map((i) => `${i.tag}: "${i.text}"`).join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Direct DOM measurement (scrollWidth/Height vs clientWidth/Height) with overflow:hidden and no text-overflow:ellipsis.',
    });
  }

  if (overflowed.length > 0) {
    ctx.onFinding({
      severity: 'low',
      area: 'UI-ElementOverflow',
      title: `${overflowed.length} element(s) have text spilling past their own box`,
      steps: [`Open ${page.url()}`, 'Inspect the elements listed below'],
      expected: 'Text content stays within its intended container',
      actual: overflowed.map((i) => `${i.tag}: "${i.text}"`).join('; '),
      evidence: [shot],
      reproRate: '1/1',
      automationCandidate: true,
      pageUrl: page.url(),
      confidence: 'verified',
      confidenceReason: 'Direct DOM measurement — content dimensions exceed the box with overflow:visible.',
    });
  }
}
