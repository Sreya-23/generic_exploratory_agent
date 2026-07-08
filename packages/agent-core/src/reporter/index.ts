import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState } from '@qa/shared';

export async function ensureSessionDir(sessionsDir: string, sessionId: string): Promise<string> {
  const dir = join(sessionsDir, sessionId);
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  await mkdir(join(dir, 'har'), { recursive: true });
  await mkdir(join(dir, 'logs'), { recursive: true });
  return dir;
}

export async function saveSessionState(
  sessionsDir: string,
  state: SessionState,
): Promise<void> {
  const dir = await ensureSessionDir(sessionsDir, state.id);
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  await writeFile(join(dir, 'config.json'), JSON.stringify(state.config, null, 2));
  if (state.plan) {
    await writeFile(join(dir, 'plan.json'), JSON.stringify(state.plan, null, 2));
  }
  await writeFile(join(dir, 'findings.json'), JSON.stringify(state.findings, null, 2));
}
