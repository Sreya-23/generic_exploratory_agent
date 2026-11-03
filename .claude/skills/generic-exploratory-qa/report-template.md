# Finding Report Template

Matches what the app writes (`packages/agent-core/src/reporter/generate-report.ts`). A finding
leads with plain English anyone can follow; the check's own technical wording sits underneath.

Use this format for every finding:

```markdown
#### [SEVERITY] {Plain-English headline — what a user would notice, e.g. "\"Fleece Jacket\" can't be added to the cart"}

**What's wrong:** {one or two everyday sentences describing what happened}

**Why it matters:** {the effect on a real user or the business}
{for an unconfirmed finding, end with: (Not yet confirmed — check the evidence before acting.)}

**How to see it yourself:**
1. {step one}
2. {step two}
3. {step three}

**Technical details**

- **Check result:** {the check's own title}
- **Check area:** {Area-Subarea, e.g. UI-Cart}
- **Page:** {URL}
- **Preconditions:** {state before the test, if any}

**Expected:** {what should happen}
**Actual:** {what happened}
**Evidence:** {screenshot paths, HAR entries, API response}
**Repro rate:** {e.g. 2/2 (also on a fresh visit)}
**Automation candidate:** {Yes/No}
**Validation status:** {Confirmed (objective signal) | Requires validation (single heuristic signal) | Possible false positive} — {why the agent is or isn't sure}
```

Writing rules:

- The headline names the symptom a user sees, not the check's internal name.
- "What's wrong" and "Why it matters" use everyday words; technical terms go under Technical details.
- Severity: critical / high / medium / low. Observations that aren't defects are written as info notes,
  listed after all bugs.

## Session Report Header

```markdown
# Exploratory QA Report

**Target:** {url}
**Depth:** {smoke|standard|deep|chaos}
**Areas:** {ui, api, chaos, ...}
**Date:** {ISO timestamp}

## Executive Summary
{1-2 sentences on overall quality and risk}

## Summary
| Severity | Count |
|----------|-------|
| Critical | N |
| High     | N |
| Medium   | N |
| Low      | N |

## Findings
{bugs, grouped and ordered: UI & interaction → API → JavaScript errors → resilience & performance → security}

## Additional Notes
{info notes — observations, not defects}

## Recommended Next Steps
1. {highest priority fix}
2. {automation candidates}
3. {areas needing deeper manual review}
```
