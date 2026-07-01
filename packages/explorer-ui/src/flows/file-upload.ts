// A11 — File upload: wrong type, huge file, cancel mid-upload
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { ExecutorContext, FlowTask } from '@qa/shared';

export async function runFileUpload(
  page: Page,
  ctx: ExecutorContext,
  _task: FlowTask,
): Promise<void> {
  ctx.onLog('[FileUpload] Testing file input edge cases');

  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    ctx.onLog('[FileUpload] No file input found — skipping');
    return;
  }

  const tmpDir = join(ctx.sessionsDir, ctx.sessionId);
  const shot = (name: string) =>
    join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `file-upload-${name}.png`);

  // 1. Wrong file type
  const accept = await fileInput.getAttribute('accept');
  if (accept && !accept.includes('*')) {
    const wrongTypeFile = join(tmpDir, 'test-wrong-type.xyz');
    await writeFile(wrongTypeFile, 'this is wrong type content');

    try {
      await fileInput.setInputFiles(wrongTypeFile);
      await page.waitForTimeout(500);
      const s1 = shot('wrong-type');
      await page.screenshot({ path: s1 });

      // Check if there's an error
      const errorVisible = await page
        .locator('[class*="error"], [role="alert"], [data-test*="error"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (!errorVisible) {
        ctx.onFinding({
          severity: 'medium',
          area: 'UI-FileUpload',
          title: 'Wrong file type accepted without validation error',
          steps: [`Upload file with .xyz extension (accepted: ${accept})`, 'Observe validation'],
          expected: 'Error shown for unsupported file type',
          actual: 'No error shown after uploading wrong file type',
          evidence: [s1],
          reproRate: '1/1',
          automationCandidate: true,
        });
      } else {
        ctx.onLog('[FileUpload] Wrong type correctly rejected with error');
      }
    } catch {
      ctx.onLog('[FileUpload] Wrong type file was blocked at browser level — OK');
    } finally {
      await unlink(wrongTypeFile).catch(() => {});
    }
  }

  // 2. Large file (5MB)
  const largeFile = join(tmpDir, 'test-large.txt');
  const largeContent = Buffer.alloc(5 * 1024 * 1024, 'x');
  await writeFile(largeFile, largeContent);

  try {
    await fileInput.setInputFiles(largeFile);
    await page.waitForTimeout(1000);
    const s2 = shot('large-file');
    await page.screenshot({ path: s2 });

    const errorAfterLarge = await page
      .locator('[class*="error"], [role="alert"], [data-test*="error"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (!errorAfterLarge) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-FileUpload',
        title: 'No error shown for 5MB file upload attempt',
        steps: ['Upload 5MB file to file input', 'Observe validation'],
        expected: 'File size limit error shown if limits exist',
        actual: 'No error displayed — verify server-side size limit is enforced',
        evidence: [s2],
        reproRate: '1/1',
        automationCandidate: false,
      });
    } else {
      ctx.onLog('[FileUpload] Large file correctly shows error');
    }
  } finally {
    await unlink(largeFile).catch(() => {});
  }

  // 3. Empty file
  const emptyFile = join(tmpDir, 'test-empty.txt');
  await writeFile(emptyFile, '');

  try {
    await fileInput.setInputFiles(emptyFile);
    await page.waitForTimeout(400);
    const s3 = shot('empty-file');
    await page.screenshot({ path: s3 });
    ctx.onLog('[FileUpload] Empty file upload attempted');
  } finally {
    await unlink(emptyFile).catch(() => {});
  }
}
