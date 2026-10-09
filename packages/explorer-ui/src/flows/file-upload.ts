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

  // 0. Native file-chooser dialog — distinct from setInputFiles() below (which bypasses the
  // real OS picker entirely). If a visible trigger control wraps/opens the (often visually
  // hidden) file input, clicking it should raise a genuine 'filechooser' event — confirming
  // the upload affordance is actually reachable the way a real user would use it.
  const uploadTrigger = page.locator(
    'button:has-text("Upload"), button:has-text("Choose file"), button:has-text("Browse"), label[for]:has-text("Upload"), [class*="upload" i]:visible button',
  ).first();
  if ((await uploadTrigger.count()) > 0) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 3000 }),
        uploadTrigger.click(),
      ]);
      ctx.onLog(`[FileUpload] Native file-chooser dialog opened correctly via visible trigger (multiple=${chooser.isMultiple()})`);
      // Dismiss it cleanly rather than leaving a real OS dialog state hanging.
      await chooser.setFiles([]).catch(() => {});
    } catch {
      ctx.onLog('[FileUpload] No native filechooser event fired within 3s after clicking the upload trigger — the control may rely on a hidden input clicked programmatically, which is a valid pattern, not necessarily a bug');
    }
  } else {
    ctx.onLog('[FileUpload] No distinct visible upload trigger found (file input may be directly visible/styled) — skipping native file-chooser check');
  }

  // 1. Valid file upload — the single most important case, previously untested: does a
  // completely ordinary, correctly-typed file actually succeed with positive feedback?
  const validFile = join(tmpDir, 'qa-valid-upload.txt');
  await writeFile(validFile, 'qa valid upload test content');
  try {
    await fileInput.setInputFiles(validFile);
    await page.waitForTimeout(800);
    const sValid = shot('valid-upload');
    await page.screenshot({ path: sValid });

    const errorVisible = await page
      .locator('[class*="error"], [role="alert"], [data-test*="error"]')
      .first()
      .isVisible()
      .catch(() => false);
    // A reasonable positive signal: the filename now appears somewhere on the page (a common
    // pattern for both native file inputs, which show it natively, and custom upload widgets).
    const filenameShown = await page.getByText('qa-valid-upload', { exact: false }).first().isVisible().catch(() => false);

    if (errorVisible) {
      ctx.onFinding({
        severity: 'medium',
        area: 'UI-FileUpload',
        title: 'A completely valid file upload shows an error',
        steps: ['Upload a small, plain .txt file with ordinary content'],
        expected: 'A valid file should be accepted without any error',
        actual: 'An error/alert element is visible after uploading a valid file',
        evidence: [sValid],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'The error element detected may be unrelated to the upload (e.g. a pre-existing banner) — verify it actually references the upload before treating as confirmed.',
      });
    } else if (!filenameShown) {
      ctx.onLog('[FileUpload] Valid upload: no error shown, but no filename/confirmation text found either — inconclusive, not flagged (many upload widgets show a generic icon/thumbnail instead of the filename as text)');
    } else {
      ctx.onLog('[FileUpload] Valid file upload succeeded with visible confirmation — OK');
    }
  } finally {
    await unlink(validFile).catch(() => {});
  }

  // 1b. Multi-file upload, only if the input declares support for it.
  const supportsMultiple = (await fileInput.getAttribute('multiple')) !== null;
  if (supportsMultiple) {
    const fileA = join(tmpDir, 'qa-multi-a.txt');
    const fileB = join(tmpDir, 'qa-multi-b.txt');
    await writeFile(fileA, 'file a');
    await writeFile(fileB, 'file b');
    try {
      await fileInput.setInputFiles([fileA, fileB]);
      await page.waitForTimeout(600);
      const bothShown =
        (await page.getByText('qa-multi-a', { exact: false }).first().isVisible().catch(() => false)) &&
        (await page.getByText('qa-multi-b', { exact: false }).first().isVisible().catch(() => false));
      if (!bothShown) {
        ctx.onLog('[FileUpload] Multi-file input accepted 2 files, but could not confirm both are visibly listed — inconclusive (widget may not show filenames as text)');
      } else {
        ctx.onLog('[FileUpload] Multi-file upload: both files correctly registered');
      }
    } finally {
      await unlink(fileA).catch(() => {});
      await unlink(fileB).catch(() => {});
    }
  } else {
    ctx.onLog('[FileUpload] Input has no "multiple" attribute — multi-file case not applicable');
  }

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

  // 4. Remove uploaded file — if a visible remove/× control appeared after the last upload,
  // clicking it should clear the attached file.
  const removeControl = page.locator(
    'button[aria-label*="remove" i], button[title*="remove" i], [class*="remove-file" i]:visible, button:has-text("Remove")',
  ).first();
  if ((await removeControl.count()) > 0 && (await removeControl.isVisible().catch(() => false))) {
    await removeControl.click().catch(() => {});
    await page.waitForTimeout(400);
    const stillShowsFile = await page.getByText('test-empty', { exact: false }).first().isVisible().catch(() => false);
    if (stillShowsFile) {
      ctx.onFinding({
        severity: 'low',
        area: 'UI-FileUpload',
        title: 'Remove-file control does not clear the attached file',
        steps: ['Upload a file', 'Click the remove/× control'],
        expected: 'The attached file should be cleared from the UI',
        actual: 'The previously uploaded filename is still shown after clicking remove',
        evidence: [],
        reproRate: '1/1',
        automationCandidate: true,
        confidence: 'heuristic',
        confidenceReason: 'Text-presence check only — the widget may show the filename in an unrelated, still-correct context. Verify before treating as confirmed.',
      });
    } else {
      ctx.onLog('[FileUpload] Remove-file control correctly clears the attachment');
    }
  } else {
    ctx.onLog('[FileUpload] No visible remove-file control found — skipping');
  }
}
