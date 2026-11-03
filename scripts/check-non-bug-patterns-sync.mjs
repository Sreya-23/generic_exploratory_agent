#!/usr/bin/env node
// Drift checker for the false-positive pattern library: every entry in NON_BUG_PATTERNS
// (packages/explorer-ui/src/flows/non-bug-patterns.ts) is enforced, real code — but the
// *reasoning* behind each one (what false positive it closes, how it was found) only exists as
// prose in SKILL.md's changelog. Nothing stops someone adding a new pattern to the code without
// ever writing down why, which is exactly the kind of doc/code drift the matrix checker guards
// against for a different file. This can't auto-write good prose (that needs a human who knows
// the story), but it CAN catch the one thing that's mechanically checkable: did anyone forget to
// add a changelog entry at all.
//
// Usage: node scripts/check-non-bug-patterns-sync.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_PATH = join(ROOT, '.claude/skills/generic-exploratory-qa/SKILL.md');

const { NON_BUG_PATTERNS } = await import(join(ROOT, 'packages/explorer-ui/dist/flows/non-bug-patterns.js'));

const skillText = readFileSync(SKILL_PATH, 'utf-8');
const changelogStart = skillText.indexOf('## Changelog');
const changelog = changelogStart === -1 ? '' : skillText.slice(changelogStart);

// Word-overlap match, not an exact phrase — existing changelog prose paraphrases rather than
// quoting the pattern's id/label verbatim (e.g. "App-download-gate misread..." for id "app-gate",
// "generic empty states" for label "Generic empty/loading state"). Require every significant
// word from the id to appear somewhere in the changelog text, case-insensitively.
const changelogLower = changelog.toLowerCase();
const undocumented = NON_BUG_PATTERNS.filter((p) => {
  const words = p.id.split(/[-_]/).filter((w) => w.length > 2);
  return !words.every((w) => changelogLower.includes(w));
});

if (undocumented.length === 0) {
  console.log(`[patterns-check] All ${NON_BUG_PATTERNS.length} non-bug patterns are referenced in SKILL.md's changelog.`);
  process.exit(0);
}

console.log(`[patterns-check] ${undocumented.length} pattern(s) added to NON_BUG_PATTERNS with no changelog entry:\n`);
for (const p of undocumented) {
  console.log(`  "${p.id}" (${p.label}) — add a changelog entry explaining what false positive this closes and how it was found`);
}
process.exit(1);
