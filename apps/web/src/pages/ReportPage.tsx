import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSessionReport, getSession, type SessionState } from '../api/client';

export function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionState | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    Promise.all([getSession(id), fetchSessionReport(id, 'md')])
      .then(([s, md]) => {
        setSession(s);
        setMarkdown(typeof md === 'string' ? md : '');
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  if (error) {
    return (
      <div className="page">
        <h1>Report</h1>
        <p className="error-banner">{error}</p>
        <Link to="/">← Home</Link>
      </div>
    );
  }

  if (!session) {
    return <div className="page loading">Loading report…</div>;
  }

  const coverage = session.prdCoverage;
  const diff = coverage?.findingDiff;

  return (
    <div className="page report-page">
      <div className="report-header">
        <div>
          <h1>Exploration Report</h1>
          <p className="target-url">{session.config.targetUrl}</p>
          {session.config.prdFilename && (
            <p className="prd-upload-status prd-attached">
              PRD-only mode · {session.config.prdFilename}
            </p>
          )}
        </div>
        <div className="report-actions">
          <Link to={`/session/${session.id}`} className="btn btn-secondary">
            Live session
          </Link>
          <a
            className="btn btn-primary"
            href={`/api/sessions/${session.id}/report?format=md`}
            download={`qa-report-${session.id}.md`}
          >
            Download Markdown
          </a>
        </div>
      </div>

      {coverage && (
        <section className="prd-coverage-card">
          <h2>PRD coverage</h2>
          <ul>
            <li>Features extracted: {coverage.featuresExtracted.length}</li>
            <li>Passed: {coverage.passedCount}</li>
            <li>Failed: {coverage.failedCount}</li>
            <li>Gaps: {coverage.gaps.length}</li>
            <li>Blocked: {coverage.blocked.length}</li>
            {diff && (
              <li>
                Diff vs previous: +{diff.newFindings.length} new / −{diff.fixedFindings.length}{' '}
                fixed / {diff.recurringFindings.length} recurring
              </li>
            )}
          </ul>

          {coverage.featureDetails && coverage.featureDetails.length > 0 && (
            <div className="prd-criteria-list">
              <h3>Requirements & criteria</h3>
              <ul>
                {coverage.featureDetails.map((d) => (
                  <li key={d.requirementId}>
                    <strong>{d.requirementId}</strong> — {d.name}
                    {d.criteria ? <div className="prd-criteria-snip">{d.criteria}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {coverage.featureResults?.length > 0 && (
            <div className="prd-trace-table-wrap">
              <h3>Traceability</h3>
              <table className="prd-trace-table">
                <thead>
                  <tr>
                    <th>Req</th>
                    <th>Task</th>
                    <th>Feature</th>
                    <th>Variant</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.featureResults.map((r, i) => (
                    <tr key={`${r.taskId ?? r.feature}-${r.variant}-${i}`}>
                      <td>{r.requirementId ?? '—'}</td>
                      <td>
                        <code>{r.taskId ?? '—'}</code>
                      </td>
                      <td>{r.feature}</td>
                      <td>{r.variant}</td>
                      <td>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <pre className="report-markdown">{markdown}</pre>
    </div>
  );
}
