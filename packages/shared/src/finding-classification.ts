import type { Finding } from './types.js';

/**
 * What a Finding actually represents, independent of its severity — the distinction the
 * reporting pipeline was missing (a report could show "60 findings" built one way and "55
 * findings" built another, and a single unvalidated heuristic finding could drive the health
 * score to a flat F). Every report-facing count/section/score must be built from this single
 * classification rather than each place re-deriving its own notion of "is this a bug".
 *
 * - 'execution-error' — the AGENT failed to finish a check (a timeout, a crashed step, the
 *   target being briefly unreachable). Evidence about the agent's own run, not about the
 *   application under test — never counted as a defect or scored.
 * - 'observation'     — info-severity by construction (expected === actual, e.g. "endpoint
 *   exists") or explicitly quarantined as a known non-bug/demo quirk. Not a defect.
 * - 'potential-defect'— a real candidate defect, but only backed by a single heuristic signal
 *   (Finding.confidence === 'heuristic') — needs human/validator confirmation before being
 *   treated as real.
 * - 'confirmed-defect'— everything else: backed by an objective signal (confidence === 'verified'),
 *   or a check that doesn't tag confidence at all (most of this codebase's checks predate that
 *   field and report an objective fact — an HTTP status, a thrown exception, a DOM measurement).
 */
export type FindingResultType = 'confirmed-defect' | 'potential-defect' | 'observation' | 'execution-error';

// Areas used exclusively for the agent's own run-level failures (ui-executor.ts's "Task error:"
// findings, and the orchestrator's "target appears unavailable" streak note) — never areas a
// real check uses for an application-level defect.
const EXECUTION_ERROR_AREAS = new Set(['UI-Error', 'UI-Environment']);

export function isExecutionError(f: Finding): boolean {
  return EXECUTION_ERROR_AREAS.has(f.area) || (f.tags ?? []).includes('env-degraded');
}

export function isObservation(f: Finding): boolean {
  return f.severity === 'info' || !!f.quarantineReason;
}

/** The second-pass AI validator (validateFindingsWithAI) never removes a finding — it only
 *  appends this marker text to confidenceReason when it believes the finding isn't real. Kept
 *  as a plain substring check (not a separate boolean field) so the validator stays additive-only,
 *  per its own documented contract. */
const VALIDATOR_FLAGGED_MARKER = 'flagged this as possibly not a real defect';

export function isLikelyFalsePositive(f: Finding): boolean {
  return !!f.confidenceReason?.includes(VALIDATOR_FLAGGED_MARKER);
}

export function resultTypeOf(f: Finding): FindingResultType {
  if (isExecutionError(f)) return 'execution-error';
  if (isObservation(f)) return 'observation';
  if (f.confidence === 'heuristic') return 'potential-defect';
  return 'confirmed-defect';
}

export interface FindingBuckets {
  confirmedDefects: Finding[];
  potentialDefects: Finding[];
  observations: Finding[];
  executionErrors: Finding[];
}

export function bucketFindings(findings: Finding[]): FindingBuckets {
  const buckets: FindingBuckets = {
    confirmedDefects: [],
    potentialDefects: [],
    observations: [],
    executionErrors: [],
  };
  for (const f of findings) {
    const type = resultTypeOf(f);
    if (type === 'confirmed-defect') buckets.confirmedDefects.push(f);
    else if (type === 'potential-defect') buckets.potentialDefects.push(f);
    else if (type === 'observation') buckets.observations.push(f);
    else buckets.executionErrors.push(f);
  }
  return buckets;
}
