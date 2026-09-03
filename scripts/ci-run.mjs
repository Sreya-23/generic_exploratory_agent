#!/usr/bin/env node
/**
 * CI/CD entry point — run an exploration session against a target URL (e.g. a PR preview
 * deployment) and fail the job if findings at or above a severity threshold are found.
 *
 * Assumes the API server is already running (start it with `npm run dev:api` or an
 * equivalent production start command before invoking this script).
 *
 * Usage:
 *   node scripts/ci-run.mjs <targetUrl> [options]
 *
 * Options:
 *   --api=<url>         API base URL (default: http://localhost:3001)
 *   --depth=<depth>     smoke | standard | deep | chaos (default: smoke)
 *   --fail-on=<sev>     critical | high | medium | low (default: high) — exit 1 if any
 *                       finding at or above this severity is present
 *   --username=<user>   Login username, if the target requires auth
 *   --password=<pass>   Login password, if the target requires auth
 *   --report-out=<path> Write the markdown report to this file (default: qa-report.md)
 *   --poll-interval=<ms>  Status poll interval in ms (default: 5000)
 *   --timeout=<ms>      Give up waiting after this long (default: 1800000 = 30min)
 *
 * Exit codes: 0 = passed (no findings at/above threshold), 1 = failed threshold or error.
 */

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function parseArgs(argv) {
  const args = { targetUrl: null, api: 'http://localhost:3001', depth: 'smoke', failOn: 'high',
    reportOut: 'qa-report.md', pollInterval: 5000, timeout: 1_800_000 };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      args.targetUrl = arg;
      continue;
    }
    const [key, value] = arg.slice(2).split('=');
    switch (key) {
      case 'api': args.api = value; break;
      case 'depth': args.depth = value; break;
      case 'fail-on': args.failOn = value; break;
      case 'username': args.username = value; break;
      case 'password': args.password = value; break;
      case 'report-out': args.reportOut = value; break;
      case 'poll-interval': args.pollInterval = Number(value); break;
      case 'timeout': args.timeout = Number(value); break;
      default: break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.targetUrl) {
    console.error('Usage: node scripts/ci-run.mjs <targetUrl> [--depth=smoke] [--fail-on=high] ...');
    process.exit(1);
  }

  const credentials = args.username
    ? { type: 'login', authMethod: 'password', username: args.username, password: args.password ?? '' }
    : { type: 'none' };

  console.log(`[ci-run] Creating session for ${args.targetUrl} (depth=${args.depth})`);
  const createRes = await fetch(`${args.api}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetUrl: args.targetUrl,
      depth: args.depth,
      areas: ['ui', 'api', 'chaos', 'security', 'performance', 'regression', 'accessibility'],
      credentials,
    }),
  });
  if (!createRes.ok) {
    console.error(`[ci-run] Failed to create session: HTTP ${createRes.status}`);
    process.exit(1);
  }
  const session = await createRes.json();
  console.log(`[ci-run] Session ${session.id} created — starting`);

  const startRes = await fetch(`${args.api}/api/sessions/${session.id}/start`, { method: 'POST' });
  if (!startRes.ok) {
    console.error(`[ci-run] Failed to start session: HTTP ${startRes.status}`);
    process.exit(1);
  }

  const deadline = Date.now() + args.timeout;
  let finalState = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, args.pollInterval));
    const res = await fetch(`${args.api}/api/sessions/${session.id}`);
    if (!res.ok) continue;
    const state = await res.json();
    console.log(
      `[ci-run] status=${state.status} progress=${state.progress?.completedTasks ?? 0}/${state.progress?.totalTasks ?? 0}`,
    );
    // CI is non-interactive — nothing will ever answer a live chat prompt for credentials,
    // so waiting out the full timeout on 'awaiting_auth' just wastes the whole CI job. Fail
    // fast instead, with a message that tells the operator exactly what's missing.
    if (state.status === 'awaiting_auth') {
      console.error(
        '[ci-run] Target requires login credentials but none were provided (or they were ' +
          'rejected) — pass --username/--password. CI cannot answer an interactive prompt.',
      );
      process.exit(1);
    }
    if (state.status === 'completed' || state.status === 'failed') {
      finalState = state;
      break;
    }
  }

  if (!finalState) {
    console.error(`[ci-run] Timed out after ${args.timeout}ms waiting for session to finish`);
    process.exit(1);
  }

  const reportRes = await fetch(`${args.api}/api/sessions/${session.id}/report`);
  const report = await reportRes.json();

  const { writeFileSync } = await import('node:fs');
  writeFileSync(args.reportOut, report.markdown ?? '(no markdown report available)');
  console.log(`[ci-run] Report written to ${args.reportOut}`);

  const findings = report.findings ?? [];
  const threshold = SEVERITY_RANK[args.failOn] ?? SEVERITY_RANK.high;
  const blocking = findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= threshold && !f.quarantineReason);

  console.log(`[ci-run] ${findings.length} total finding(s), health score: ${report.healthScore?.score}/100 (${report.healthScore?.grade})`);

  if (blocking.length > 0) {
    console.error(`[ci-run] FAILED — ${blocking.length} finding(s) at or above severity "${args.failOn}":`);
    for (const f of blocking.slice(0, 20)) {
      console.error(`  [${f.severity.toUpperCase()}] ${f.title}`);
    }
    process.exit(1);
  }

  console.log(`[ci-run] PASSED — no findings at or above severity "${args.failOn}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[ci-run] Unexpected error:', err);
  process.exit(1);
});
