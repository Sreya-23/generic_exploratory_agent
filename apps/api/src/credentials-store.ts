// Saved logins per site, per role — a single website may have several accounts worth testing
// repeatedly (different roles, different phone numbers for OTP) and re-typing them into the
// setup form every session is exactly the kind of busywork this tool exists to remove. Stored
// as a structured file (not .env) because the shape is inherently nested — domain -> role ->
// several fields — which .env's flat KEY=value format handles poorly once there's more than
// one role per site. Gitignored (see .gitignore) since this holds real login usernames/
// passwords, some of them for live accounts.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SavedCredential {
  username?: string;
  password?: string;
  authMethod?: string;
  extras?: Record<string, string>;
}

type CredentialsFile = Record<string, Record<string, SavedCredential>>;

function credentialsFilePath(root: string): string {
  return join(root, 'credentials.json');
}

async function loadAll(root: string): Promise<CredentialsFile> {
  const path = credentialsFilePath(root);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Corrupt file — treat as empty rather than crashing the API; a save will rewrite it cleanly.
    return {};
  }
}

export async function loadCredentialsForHost(root: string, hostname: string): Promise<Record<string, SavedCredential>> {
  const all = await loadAll(root);
  return all[hostname] ?? {};
}

export async function saveCredential(
  root: string,
  hostname: string,
  role: string,
  credential: SavedCredential,
): Promise<void> {
  const all = await loadAll(root);
  all[hostname] = { ...(all[hostname] ?? {}), [role]: credential };
  await writeFile(credentialsFilePath(root), JSON.stringify(all, null, 2), 'utf-8');
}

export async function deleteCredential(root: string, hostname: string, role: string): Promise<void> {
  const all = await loadAll(root);
  if (!all[hostname]) return;
  delete all[hostname][role];
  if (Object.keys(all[hostname]).length === 0) delete all[hostname];
  await writeFile(credentialsFilePath(root), JSON.stringify(all, null, 2), 'utf-8');
}
