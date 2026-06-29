# Finding Report Template

Use this format for every finding:

```markdown
### [SEVERITY] Title — Area: {Area-Subarea}

**Preconditions:** {state before test}
**Steps:**
1. {step one}
2. {step two}
3. {step three}

**Expected:** {what should happen}
**Actual:** {what happened}
**Evidence:** {screenshot paths, HAR entries, API response}
**Repro rate:** {e.g. 3/3}
**Automation candidate:** {Yes/No}
```

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
| Info     | N |

## Findings
{individual findings}

## Recommended Next Steps
1. {highest priority fix}
2. {automation candidates}
3. {areas needing deeper manual review}
```
