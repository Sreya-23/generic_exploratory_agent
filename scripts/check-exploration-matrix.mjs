#!/usr/bin/env node
// Drift checker for .claude/skills/generic-exploratory-qa/exploration-matrix.md's Status column.
//
// The matrix is hand-maintained prose (the "What it does" column can't be auto-written), but the
// ✅/🔄/📋 status is a plain fact about the code: does a real handler exist, and is it actually
// scheduled by default? Those two questions are answered by reading the real dispatch tables and
// ALL_AREAS/FLOW_CLASSES directly, not by trusting whatever a human last typed in the doc — the
// exact kind of drift AGENTS.md warns about ("never mark a matrix ID done before a real
// FLOW_HANDLERS entry exists and is wired into ALL_AREAS").
//
// Usage: node scripts/check-exploration-matrix.mjs [--write]
//   (no flag)  report mismatches, exit 1 if any found — safe to wire into CI
//   --write    also apply the unambiguous upgrades (📋/🔄 -> ✅) directly to the file

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MATRIX_PATH = join(ROOT, '.claude/skills/generic-exploratory-qa/exploration-matrix.md');

const { FLOW_CLASSES } = await import(join(ROOT, 'packages/shared/dist/constants.js'));
const { ALL_AREAS, FLOW_CLASS_EXECUTOR_OVERRIDE } = await import(join(ROOT, 'packages/agent-core/dist/index.js'));

// ── Extract "does a real handler exist" sets, straight from the dispatch source ─────────────
function extractMapKeys(source, mapName) {
  const start = source.indexOf(`const ${mapName}`);
  if (start === -1) return new Set();
  const openBrace = source.indexOf('{', start);
  // Find the matching closing brace by depth-counting, rather than assuming the first `};`
  // isn't itself inside a nested type/value — the map values here are function references, but
  // being defensive costs nothing.
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = source.slice(openBrace + 1, end);
  const keys = new Set();
  const re = /^\s*(?:'([a-zA-Z0-9][\w-]*)'|([a-zA-Z][\w]*))\s*:/gm;
  let m;
  while ((m = re.exec(block))) keys.add(m[1] ?? m[2]);
  return keys;
}

function extractIfChainComparisons(source) {
  const keys = new Set();
  const re = /flowClass\s*===\s*'([a-zA-Z0-9][\w-]*)'/g;
  let m;
  while ((m = re.exec(source))) keys.add(m[1]);
  return keys;
}

const uiSource = readFileSync(join(ROOT, 'packages/explorer-ui/src/ui-executor.ts'), 'utf-8');
const apiSource = readFileSync(join(ROOT, 'packages/explorer-api/src/api-executor.ts'), 'utf-8');
const chaosSource = readFileSync(join(ROOT, 'packages/chaos-engine/src/chaos-executor.ts'), 'utf-8');

const dispatchByExecutor = {
  ui: extractMapKeys(uiSource, 'FLOW_HANDLERS'),
  api: extractIfChainComparisons(apiSource),
  chaos: extractMapKeys(chaosSource, 'CHAOS_HANDLERS'),
};

// ── Which area owns each flow class, and which executor actually runs it ───────────────────
const areaOf = new Map();
for (const [area, classes] of Object.entries(FLOW_CLASSES)) {
  for (const fc of classes) areaOf.set(fc, area);
}

// api-executor.ts's area in FLOW_CLASSES isn't literally 'api' for every flow class it owns
// (performance/security checks dispatch through it too) — map FLOW_CLASSES area names to which
// dispatch-set to check, same executor-area grouping the orchestrator itself uses.
const AREA_TO_EXECUTOR = {
  ui: 'ui', chaos: 'chaos', api: 'api', security: 'api', performance: 'api',
  regression: 'ui', accessibility: 'ui',
};

function isReallyActive(flowClass) {
  const overridden = FLOW_CLASS_EXECUTOR_OVERRIDE[flowClass];
  const area = areaOf.get(flowClass);
  if (!area) return { scheduled: false, hasHandler: false };
  const scheduled = ALL_AREAS.includes(area);
  const executor = overridden ?? AREA_TO_EXECUTOR[area];
  const hasHandler = executor ? dispatchByExecutor[executor]?.has(flowClass) : false;
  return { scheduled, hasHandler };
}

// ── Parse the matrix table rows ──────────────────────────────────────────────────────────────
const matrixText = readFileSync(MATRIX_PATH, 'utf-8');
const lines = matrixText.split('\n');
const ROW_RE = /^\|\s*([A-Z]\d+)\s*\|\s*(.+?)\s*\|\s*(`[^`]+`|—)\s*\|\s*(✅|🔄|📋)\s*\|/;

const mismatches = [];
const fixedLines = [...lines];

for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(ROW_RE);
  if (!m) continue;
  const [, id, , flowClassRaw, status] = m;
  if (flowClassRaw === '—') continue; // orchestrator-level check, no FLOW_CLASSES entry to verify
  const flowClass = flowClassRaw.replace(/`/g, '');
  const { scheduled, hasHandler } = isReallyActive(flowClass);
  const trulyActive = scheduled && hasHandler;

  if (status === '✅' && !trulyActive) {
    mismatches.push({
      id, flowClass, docStatus: status,
      issue: !hasHandler
        ? `marked ✅ but no real handler found in dispatch (checked ${AREA_TO_EXECUTOR[areaOf.get(flowClass)] ?? '?'}-executor)`
        : `marked ✅ but area "${areaOf.get(flowClass)}" is not in ALL_AREAS — never scheduled by default`,
      fixable: false, // downgrading needs a human to confirm it's really dead, not a detection gap
      actionable: true, // a ✅ that isn't real is a genuine problem, never a legitimate permanent state
    });
  } else if (status === '📋' && trulyActive) {
    // 📋 unambiguously means "not implemented" — any real, scheduled handler existing is
    // straightforward drift, safe to auto-upgrade.
    mismatches.push({
      id, flowClass, docStatus: status,
      issue: `has a real, scheduled handler now — should be upgraded to ✅`,
      fixable: true,
      actionable: true,
      lineIndex: i,
    });
  } else if (status === '🔄' && trulyActive) {
    // 🔄 is ambiguous on purpose: it can mean "partially wired" (real drift, worth upgrading)
    // OR "a handler exists but this row deliberately documents a narrower scope than the full
    // check" (e.g. D5/D6, which are intentionally kept at 🔄 even though `boundary` is fully
    // wired, because the real broad coverage lives in a different row). Only a human reading
    // the row's own description can tell those apart — never auto-write this one.
    mismatches.push({
      id, flowClass, docStatus: status,
      issue: `has a real, scheduled handler — check whether this row's narrower scope is still accurate, or if it should be upgraded to ✅`,
      fixable: false,
      actionable: false, // can be a permanent, legitimate editorial choice — never fails the check on its own
    });
  }
}

if (process.argv.includes('--write')) {
  for (const mm of mismatches) {
    if (!mm.fixable) continue;
    fixedLines[mm.lineIndex] = fixedLines[mm.lineIndex].replace(/(\|\s*)(✅|🔄|📋)(\s*\|)/, `$1✅$3`);
  }
  writeFileSync(MATRIX_PATH, fixedLines.join('\n'), 'utf-8');
}

if (mismatches.length === 0) {
  console.log('[matrix-check] No drift found — status column matches real dispatch code.');
  process.exit(0);
}

console.log(`[matrix-check] ${mismatches.length} item(s) found:\n`);
for (const mm of mismatches) {
  console.log(`  ${mm.id} (${mm.flowClass}) [${mm.docStatus}] — ${mm.issue}${mm.fixable ? (process.argv.includes('--write') ? ' — FIXED' : ' — run with --write to fix') : mm.actionable ? ' — needs manual review' : ' — informational, likely a legitimate permanent state'}`);
}
// Only genuine drift (a ✅ that isn't real, or an un-upgraded 📋) fails the check — an ambiguous
// 🔄 can legitimately stay that way forever by editorial choice, so it's printed but never
// fails a CI-style run on its own.
const hasActionable = mismatches.some((mm) => mm.actionable && !(mm.fixable && process.argv.includes('--write')));
process.exit(hasActionable ? 1 : 0);
