import { useState } from 'react';
import { evidenceUrl, raiseBugsInQualityPilot, type Finding } from '../../api/client';

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
        <span className="finding-area">{finding.area}</span>
      </header>
      <h3>{finding.title}</h3>
      {finding.preconditions && (
        <p className="finding-preconditions">
          <strong>Preconditions:</strong> {finding.preconditions}
        </p>
      )}
      <div className="finding-steps">
        <strong>Steps to reproduce:</strong>
        <ol>
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
      <div className="finding-expected-actual">
        <p>
          <strong>Expected:</strong> {finding.expected}
        </p>
        <p>
          <strong>Actual:</strong> {finding.actual}
        </p>
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
