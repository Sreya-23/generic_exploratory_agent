import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';
import { isLoginWallPage } from '../flows/helpers.js';

const POST_LOGIN_FILE = 'post-login-url.txt';

/**
 * Common authenticated entry paths when root URL is still a login page. Deliberately spans
 * multiple site categories (SaaS, fintech, content, e-commerce) rather than assuming one —
 * this list is a last-resort guess, tried only after a plain reload fails to reveal a
 * naturally-redirected authenticated page.
 */
const POST_AUTH_PATHS = [
  '/dashboard',
  '/home',
  '/app',
  '/main',
  '/overview',
  '/console',
  '/workspace',
  '/portal',
  '/accounts',
  '/account',
  '/feed',
  '/admin',
  '/inventory.html',
  '/inventory',
  '/products',
  '/catalog',
];

export function sessionAuthDir(ctx: ExecutorContext): string {
  return join(ctx.sessionsDir, ctx.sessionId);
}

export function hasSavedAuthState(ctx: ExecutorContext): boolean {
  return existsSync(join(sessionAuthDir(ctx), 'auth-state.json'));
}

export function savePostLoginUrl(sessionDir: string, url: string): void {
  writeFileSync(join(sessionDir, POST_LOGIN_FILE), url, 'utf-8');
}

export function readPostLoginUrl(ctx: ExecutorContext): string | null {
  const file = join(sessionAuthDir(ctx), POST_LOGIN_FILE);
  if (!existsSync(file)) return null;
  const url = readFileSync(file, 'utf-8').trim();
  return url || null;
}

export function resolveExplorationStartUrl(ctx: ExecutorContext): string {
  if (hasSavedAuthState(ctx)) {
    const saved = readPostLoginUrl(ctx);
    if (saved) return saved;
  }
  return ctx.config.targetUrl;
}

/**
 * If cookies say we're logged in but the current page is still the login form
 * (some SPAs need a moment to recognize the restored session, or the root path is
 * always the login screen regardless of auth state), try a reload, the saved
 * post-login URL, and a category-spanning list of common authenticated paths.
 */
export async function ensureAuthenticatedLanding(
  page: Page,
  ctx: ExecutorContext,
): Promise<boolean> {
  if (!(await isLoginWallPage(page))) {
    return true;
  }

  if (!hasSavedAuthState(ctx)) {
    return false;
  }

  // Try a plain reload first — many SPAs just need a moment to recognize the restored
  // session client-side. This needs no site-specific knowledge and resolves the common
  // case without ever falling back to guessed paths.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);
  if (!(await isLoginWallPage(page))) {
    savePostLoginUrl(sessionAuthDir(ctx), page.url());
    ctx.onLog(`[Auth] Authenticated landing OK after reload: ${page.url()}`);
    return true;
  }

  const origin = new URL(ctx.config.targetUrl).origin;
  const candidates = new Set<string>();

  const saved = readPostLoginUrl(ctx);
  if (saved) candidates.add(saved);

  for (const path of POST_AUTH_PATHS) {
    candidates.add(`${origin}${path}`);
  }

  for (const url of candidates) {
    ctx.onLog(`[Auth] Still on login form — trying authenticated URL: ${url}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    if (response && !response.ok()) {
      ctx.onLog(`[Auth] ${url} returned ${response.status()} — not a real landing, skipping`);
      continue;
    }
    await page.waitForTimeout(500);
    if (!(await isLoginWallPage(page))) {
      savePostLoginUrl(sessionAuthDir(ctx), page.url());
      ctx.onLog(`[Auth] Authenticated landing OK: ${page.url()}`);
      return true;
    }
  }

  ctx.onLog('[Auth] Could not reach an authenticated page with saved session');
  return false;
}

/**
 * After a successful login form submit, leave the login page if possible and
 * persist the post-login URL for later tasks.
 */
export async function finalizePostLoginLanding(
  page: Page,
  sessionDir: string,
  targetUrl: string,
  onLog: (m: string) => void,
): Promise<string> {
  // Poll for the app's own post-submit redirect before guessing at URLs — many apps
  // (esp. server-rendered front-controller apps like OrangeHRM's index.php router) take
  // several seconds to redirect off the login form, and a single 800ms check mistakes
  // "still redirecting" for "login failed".
  let url = page.url();
  const deadline = Date.now() + 6000;
  let onWall = await isLoginWallPage(page);
  while (onWall && Date.now() < deadline) {
    await page.waitForTimeout(500);
    onWall = await isLoginWallPage(page);
  }

  if (onWall) {
    const origin = new URL(targetUrl).origin;
    for (const path of POST_AUTH_PATHS) {
      const tryUrl = `${origin}${path}`;
      onLog(`[Auth] Post-login still on form — navigating to ${tryUrl}`);
      const response = await page.goto(tryUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (response && !response.ok()) {
        onLog(`[Auth] ${tryUrl} returned ${response.status()} — not a real landing, skipping`);
        continue;
      }
      await page.waitForTimeout(500);
      if (!(await isLoginWallPage(page))) {
        url = page.url();
        break;
      }
    }
  } else {
    url = page.url();
  }

  savePostLoginUrl(sessionDir, url);
  return url;
}

export function isLoginRelatedFeature(feature: string): boolean {
  return /\b(login|log[\s-]?in|sign[\s-]?in|signin|auth(entication)?|credentials?|password|username)\b/i.test(
    feature,
  );
}
