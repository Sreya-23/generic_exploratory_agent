import type { Finding, Severity } from './types.js';
import { resultTypeOf } from './finding-classification.js';

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthScore {
  /** 0-100, higher is healthier */
  score: number;
  grade: HealthGrade;
  /** One-line human summary for a non-technical audience */
  summary: string;
  breakdown: Record<Severity, number>;
}

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

/**
 * Reduces a findings list to a single score/grade for a non-technical audience.
 *
 * Two result types never affect the score at all: 'observation' (info-severity by construction,
 * or explicitly quarantined as a known demo/environment quirk — already not a defect) and
 * 'execution-error' (the agent itself failed to finish a check — a fact about this run, not
 * about the application). A single flaky timeout, or a page that happened to print "coming
 * soon", must never be able to drag a score down or force an F grade.
 *
 * 'potential-defect' findings (backed by only one heuristic signal, not yet validated) are
 * counted at half weight — real enough to show up and lower the score, but not enough on their
 * own to justify a flat F / "unsafe to ship" read before a human has actually looked at them.
 * 'confirmed-defect' findings (an objective signal, or a check that predates confidence-tagging
 * and reports a plain fact) keep full weight, same as before this distinction existed.
 */
export function computeHealthScore(findings: Finding[]): HealthScore {
  const breakdown: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0;
  let confirmedIssues = 0;
  let potentialIssues = 0;

  for (const f of findings) {
    const resultType = resultTypeOf(f);
    if (resultType === 'observation' || resultType === 'execution-error') continue;
    breakdown[f.severity]++;
    const weight = resultType === 'potential-defect' ? 0.5 : 1;
    penalty += SEVERITY_PENALTY[f.severity] * weight;
    if (resultType === 'potential-defect') potentialIssues++;
    else confirmedIssues++;
  }

  const score = Math.max(0, Math.round(100 - penalty));
  const grade: HealthGrade =
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  const totalIssues = breakdown.critical + breakdown.high + breakdown.medium + breakdown.low;
  const validationNote = potentialIssues > 0 ? ` (${confirmedIssues} confirmed, ${potentialIssues} pending validation)` : '';
  const summary =
    totalIssues === 0
      ? 'No issues found — clean run.'
      : `${totalIssues} issue${totalIssues === 1 ? '' : 's'} found${validationNote} — ` +
        [
          breakdown.critical && `${breakdown.critical} critical`,
          breakdown.high && `${breakdown.high} high`,
          breakdown.medium && `${breakdown.medium} medium`,
          breakdown.low && `${breakdown.low} low`,
        ]
          .filter(Boolean)
          .join(', ');

  return { score, grade, summary, breakdown };
}
