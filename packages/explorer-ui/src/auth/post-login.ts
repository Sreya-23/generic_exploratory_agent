import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExecutorContext } from '@qa/shared';
import { isLoginWallPage } from '../flows/helpers.js';

const POST_LOGIN_FILE = 'post-login-url.txt';

/** Common authenticated entry paths when root URL is still a login page */
const POST_AUTH_PATHS = [
  '/inventory.html',
  '/inventory',
  '/dashboard',
  '/home',
  '/app',
  '/products',
  '/catalog',
  '/main',
  '/portal',
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
 * (common on Sauce Demo `/`), try known post-auth paths and the saved URL.
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

  const origin = new URL(ctx.config.targetUrl).origin;
  const candidates = new Set<string>();

  const saved = readPostLoginUrl(ctx);
  if (saved) candidates.add(saved);

  for (const path of POST_AUTH_PATHS) {
    candidates.add(`${origin}${path}`);
  }

  for (const url of candidates) {
    ctx.onLog(`[Auth] Still on login form — trying authenticated URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
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
  await page.waitForTimeout(800);
  let url = page.url();

  if (await isLoginWallPage(page)) {
    const origin = new URL(targetUrl).origin;
    for (const path of POST_AUTH_PATHS) {
      const tryUrl = `${origin}${path}`;
      onLog(`[Auth] Post-login still on form — navigating to ${tryUrl}`);
      await page.goto(tryUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
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
