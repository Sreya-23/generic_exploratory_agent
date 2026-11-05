import { useState } from 'react';
import { evidenceUrl, raiseBugsInQualityPilot, type Finding } from '../../api/client';
import { parseListLikeText, isLikelyFalsePositive, explainFinding } from '@qa/shared';

/** Same validation-status wording as the downloadable report (generate-report.ts) — "confirmed
 *  / requires validation / possible false positive" rather than the internal 'verified'/
 *  'heuristic' field names, so the live view and the final report never say different things. */
function ValidationBadge({ finding }: { finding: Finding }) {
  if (!finding.confidence) return null;
  if (isLikelyFalsePositive(finding)) {
    return (
      <span className="confidence-badge flagged" title={finding.confidenceReason}>
        🚩 Possible false positive
      </span>
    );
  }
  return finding.confidence === 'verified' ? (
    <span className="confidence-badge verified" title={finding.confidenceReason}>
      ✓ Confirmed
    </span>
  ) : (
    <span className="confidence-badge heuristic" title={finding.confidenceReason}>
      ⚠ Requires validation
    </span>
  );
}

/** Renders as a bulleted list when the text turns out to be a list crammed into one sentence
 *  (see parseListLikeText) — otherwise renders as the plain sentence it already is. */
function FindingText({ text }: { text: string }) {
  const structured = parseListLikeText(text);
  if (!structured) return <>{text}</>;
  return (
    <>
      {structured.intro && <span className="finding-text-intro">{structured.intro}</span>}
      <ul className="finding-text-list">
        {structured.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

const SEVERITY_CLASS: Record<Finding['severity'], string> = {
  critical: 'finding-critical',
  high: 'finding-high',
  medium: 'finding-medium',
  low: 'finding-low',
  info: 'finding-info',
};

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function FindingCard({ finding, sessionId }: { finding: Finding; sessionId: string }) {
  const steps =
    finding.steps.length > 0 ? finding.steps : ['(no steps recorded)'];
  const screenshots = (finding.evidence ?? []).filter((e) => IMAGE_EXT.test(e));
  const rawEvidence = (finding.evidence ?? []).filter((e) => !IMAGE_EXT.test(e));
  const plain = explainFinding(finding);
  const [raiseStatus, setRaiseStatus] = useState<'idle' | 'raising' | 'done' | 'error'>('idle');
  const [raiseMessage, setRaiseMessage] = useState('');

  const handleRaise = async () => {
    setRaiseStatus('raising');
    try {
      const result = await raiseBugsInQualityPilot(sessionId, [finding.id]);
      setRaiseStatus('done');
      setRaiseMessage(result.created > 0 ? 'Raised in QualityPilot' : 'No bug created — check QualityPilot');
    } catch (err) {
      setRaiseStatus('error');
      setRaiseMessage((err as Error).message);
    }
  };

  return (
    <article className={`finding-card ${SEVERITY_CLASS[finding.severity]}`}>
      <header>
        <span className="finding-severity">{finding.severity}</span>
        <span className="finding-area" title={`Check area: ${finding.area}`}>{plain.areaLabel}</span>
        <ValidationBadge finding={finding} />
      </header>
      {/* Plain-English first, so anyone can read it; the technical detail is kept below. */}
      <h3>{plain.headline}</h3>
      <div className="finding-plain">
        <p>
          <strong>What's wrong:</strong> {plain.summary}
        </p>
        <p>
          <strong>Why it matters:</strong> {plain.whyItMatters}
        </p>

      </div>
      <div className="finding-steps">
        <strong>How to see it yourself:</strong>
        <ol>
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
      {screenshots.length > 0 && (
        <div className="finding-evidence">
          {screenshots.map((path, i) => {
            const url = evidenceUrl(sessionId, path);
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                <img className="finding-evidence-shot" src={url} alt={`Evidence ${i + 1}`} loading="lazy" />
              </a>
            );
          })}
        </div>
      )}
      <details className="finding-technical">
        <summary>Technical details</summary>
        <p className="finding-preconditions">
          <strong>Check result:</strong> {finding.title}
        </p>
        {finding.pageUrl && (
          <p className="finding-preconditions">
            <strong>Page:</strong> {finding.pageUrl}
          </p>
        )}
        {finding.preconditions && (
          <p className="finding-preconditions">
            <strong>Preconditions:</strong> {finding.preconditions}
          </p>
        )}
        <div className="finding-expected-actual">
          <div className="finding-expected-actual-row">
            <strong>Expected:</strong> <FindingText text={finding.expected} />
          </div>
          <div className="finding-expected-actual-row">
            <strong>Actual:</strong> <FindingText text={finding.actual} />
          </div>
        </div>
        {finding.confidenceReason && (
          <p className="finding-preconditions">
            <strong>How sure the agent is:</strong> {finding.confidenceReason}
          </p>
        )}
        {rawEvidence.length > 0 && (
          <div className="finding-evidence-raw">
            {rawEvidence.map((path, i) => (
              <a
                key={i}
                href={evidenceUrl(sessionId, path)}
                target="_blank"
                rel="noopener noreferrer"
                className="evidence-raw-link"
              >
                View raw request/response{rawEvidence.length > 1 ? ` #${i + 1}` : ''}
              </a>
            ))}
          </div>
        )}
      </details>
      <footer>
        <span>Repro: {finding.reproRate}</span>
        {finding.automationCandidate && <span className="auto-badge">Automatable</span>}
        {finding.severity !== 'info' && (
          <span className="finding-raise-bug">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRaise}
              disabled={raiseStatus === 'raising' || raiseStatus === 'done'}
            >
              {raiseStatus === 'raising' ? 'Raising…' : raiseStatus === 'done' ? 'Raised ✓' : 'Raise as bug in QualityPilot'}
            </button>
            {raiseMessage && (
              <span className={raiseStatus === 'error' ? 'error-banner' : 'session-meta'}> {raiseMessage}</span>
            )}
          </span>
        )}
      </footer>
    </article>
  );
}
