import type { Finding, Severity } from './types.js';

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
 * Quarantined findings (known demo/environment quirks, not real defects) are excluded
 * from both the breakdown and the penalty so they don't unfairly tank the score.
 */
export function computeHealthScore(findings: Finding[]): HealthScore {
  const breakdown: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0;

  for (const f of findings) {
    if (f.quarantineReason) continue;
    breakdown[f.severity]++;
    penalty += SEVERITY_PENALTY[f.severity];
  }

  const score = Math.max(0, Math.round(100 - penalty));
  const grade: HealthGrade =
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  const totalIssues = breakdown.critical + breakdown.high + breakdown.medium + breakdown.low;
  const summary =
    totalIssues === 0
      ? 'No issues found — clean run.'
      : `${totalIssues} issue${totalIssues === 1 ? '' : 's'} found — ` +
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
