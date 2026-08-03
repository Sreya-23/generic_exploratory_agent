import { Link, useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import type { Finding, Severity } from '@qa/shared';
import {
  getSession,
  getSessionReport,
  reportDownloadUrl,
  type SessionReportPayload,
  type SessionState,
} from '../api/client';
import { FindingCard } from '../components/session/FindingCard';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionState | null>(null);
  const [report, setReport] = useState<SessionReportPayload | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'overview' | 'findings' | 'markdown'>('overview');

  useEffect(() => {
    if (!id) return;
    let active = true;

    Promise.all([getSession(id), getSessionReport(id)])
      .then(([s, r]) => {
        if (!active) return;
        setSession(s);
        setReport(r);
      })
      .catch(() => {
        if (!active) return;
        setError('Report not found. The session may have expired after a server restart.');
      });

    return () => {
      active = false;
    };
  }, [id]);

  const sortedFindings = useMemo(() => {
    const findings = report?.findings ?? session?.findings ?? [];
    return [...findings].sort(
      (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
    );
  }, [report, session]);

  const flowsByArea = useMemo(() => {
    const flows = report?.flowsCovered ?? [];
    const map = new Map<string, typeof flows>();
    for (const f of flows) {
      const list = map.get(f.area) ?? [];
      list.push(f);
      map.set(f.area, list);
    }
    return [...map.entries()];
  }, [report]);

  if (error) {
    return (
      <div className="page">
        <h1>Report Unavailable</h1>
        <p className="error-banner">{error}</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>
          Back Home
        </Link>
      </div>
    );
  }

  if (!session || !report) {
    return <div className="page loading">Building report...</div>;
  }

  const bySeverity = report.bySeverity;
  const htmlUrl = reportDownloadUrl(session.id, 'html');
  const mdUrl = reportDownloadUrl(session.id, 'md');
  const findingsByArea = report.findingsByArea ?? [];

  return (
    <div className="page report-page">
      <div className="report-header">
        <div>
          <h1>Exploratory QA Report</h1>
          <p className="target-url">{session.config.targetUrl}</p>
          <p className="session-meta">
            {session.config.depth} · {session.config.areas.join(', ')} ·{' '}
            {report.flowsCovered?.length ?? session.plan?.tasks.length ?? 0} flows · {report.total}{' '}
            findings
            {session.classification
              ? ` · ${session.classification.siteType} (${Math.round(session.classification.confidence * 100)}%)`
              : ''}
          </p>
        </div>
        <div className="report-actions">
          <Link to={`/session/${session.id}`} className="btn btn-secondary">
            Live Session
          </Link>
          <a className="btn btn-secondary" href={mdUrl} download>
            Download Markdown
          </a>
          <a className="btn btn-secondary" href={htmlUrl} download>
            Download styled HTML
          </a>
          <a className="btn btn-primary" href={htmlUrl} target="_blank" rel="noreferrer">
            Open report / Save PDF
          </a>
        </div>
      </div>

      <section className="severity-summary">
        <span className="severity-chip info">
          flows: {report.flowsCovered?.length ?? session.plan?.tasks.length ?? 0}
        </span>
        {SEVERITIES.map((sev) => (
          <span key={sev} className={`severity-chip ${sev}`}>
            {sev}: {bySeverity[sev]}
          </span>
        ))}
      </section>

      <div className="report-actions" style={{ marginBottom: '1.25rem' }}>
        <button
          type="button"
          className={`btn ${view === 'overview' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          className={`btn ${view === 'findings' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('findings')}
        >
          Findings
        </button>
        <button
          type="button"
          className={`btn ${view === 'markdown' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('markdown')}
        >
          Full Markdown
        </button>
      </div>

      {view === 'overview' && (
        <>
          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Executive Summary</h2>
            <p>{report.executiveSummary}</p>
          </section>

          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Session details</h2>
            <table className="report-overview-table">
              <tbody>
                <tr>
                  <th>Tasks completed</th>
                  <td>
                    {session.progress.completedTasks} / {session.progress.totalTasks}
                  </td>
                </tr>
                <tr>
                  <th>Site type</th>
                  <td>
                    {session.classification
                      ? `${session.classification.siteType} (${Math.round(session.classification.confidence * 100)}%)`
                      : 'not classified'}
                  </td>
                </tr>
                <tr>
                  <th>Journeys</th>
                  <td>{session.classification?.inferredJourneys?.slice(0, 5).join(', ') || '—'}</td>
                </tr>
                <tr>
                  <th>API endpoints discovered</th>
                  <td>{session.discoveredApiEndpoints?.length ?? 0}</td>
                </tr>
                <tr>
                  <th>Authentication</th>
                  <td>
                    {session.authProbe?.requiresAuth === false
                      ? 'No login required'
                      : session.authProbe?.suggestedMethod ??
                        session.config.credentials?.type ??
                        'not probed'}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Flows tested ({report.flowsCovered?.length ?? 0})</h2>
            {flowsByArea.length === 0 ? (
              <p className="empty-state">No plan tasks were recorded for this session.</p>
            ) : (
              flowsByArea.map(([area, rows]) => (
                <div key={area} style={{ marginBottom: '1.25rem' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
                    {area}{' '}
                    <span className="session-meta">({rows.length} flows)</span>
                  </h3>
                  <table className="report-overview-table">
                    <thead>
                      <tr>
                        <th>Flow</th>
                        <th>What was tested</th>
                        <th>Steps to reproduce</th>
                        <th>Findings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.flowClass + row.title}>
                          <td>
                            <strong>{row.title}</strong>
                            <div className="session-meta">{row.flowClass}</div>
                          </td>
                          <td>{row.description || '—'}</td>
                          <td>
                            {row.steps && row.steps.length > 0 ? (
                              <ol className="report-flow-steps">
                                {row.steps.map((s, i) => (
                                  <li key={i}>{s}</li>
                                ))}
                              </ol>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>{row.findingsCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>

          {findingsByArea.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Findings by area</h2>
              <table className="report-overview-table">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {findingsByArea.map((g) => (
                    <tr key={g.area}>
                      <td>{g.area}</td>
                      <td>{g.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Recommended Next Steps</h2>
            <ol>
              {report.recommendedNextSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
        </>
      )}

      {view === 'findings' && (
        <section className="findings-panel">
          <h2>Findings ({sortedFindings.length})</h2>
          {sortedFindings.length === 0 ? (
            <p className="empty-state">No findings were recorded during this exploration.</p>
          ) : (
            <div className="findings-list">
              {sortedFindings.map((f: Finding) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
          )}
        </section>
      )}

      {view === 'markdown' && <pre className="report-markdown">{report.markdown}</pre>}
    </div>
  );
}
