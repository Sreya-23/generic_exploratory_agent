import type { Finding } from '../../api/client';

const SEVERITY_CLASS: Record<Finding['severity'], string> = {
  critical: 'finding-critical',
  high: 'finding-high',
  medium: 'finding-medium',
  low: 'finding-low',
  info: 'finding-info',
};

export function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className={`finding-card ${SEVERITY_CLASS[finding.severity]}`}>
      <header>
        <span className="finding-severity">{finding.severity}</span>
        <span className="finding-area">{finding.area}</span>
      </header>
      <h3>{finding.title}</h3>
      <div className="finding-steps">
        <strong>Steps:</strong>
        <ol>
          {finding.steps.map((s, i) => (
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
      <footer>
        <span>Repro: {finding.reproRate}</span>
        {finding.automationCandidate && <span className="auto-badge">Automatable</span>}
      </footer>
    </article>
  );
}
