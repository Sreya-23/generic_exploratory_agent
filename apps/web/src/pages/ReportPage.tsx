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
import { QualityPilotConnect } from '../components/session/QualityPilotConnect';
import { FindingsChatPanel } from '../components/chat/FindingsChatPanel';
import { SETUP_CONV_KEY } from './ChatSetupPage';

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

  const applicationMapGroups = useMemo(() => {
    const routes = session?.discoveredRoutes ?? [];
    const groups = new Map<string, string[]>();
    for (const route of routes) {
      let path = route;
      try {
        path = new URL(route).pathname;
      } catch {
        /* keep raw route */
      }
      const segment = path.split('/').filter(Boolean)[0] || '(root)';
      const list = groups.get(segment) ?? [];
      if (!list.includes(path)) list.push(path);
      groups.set(segment, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [session]);

  const environmentMatrix = useMemo(() => {
    const checks = session?.environmentChecks ?? [];
    if (checks.length === 0) return null;
    const pages = [...new Set(checks.map((c) => c.pageUrl))];
    const browserEnvs: string[] = [];
    const deviceEnvs: string[] = [];
    for (const c of checks) {
      const bucket = c.kind === 'browser' ? browserEnvs : deviceEnvs;
      if (!bucket.includes(c.environment)) bucket.push(c.environment);
    }
    browserEnvs.sort((a, b) => (a === 'Chromium' ? -1 : b === 'Chromium' ? 1 : 0));
    const environments = [...browserEnvs, ...deviceEnvs];
    const byPageEnv = new Map<string, (typeof checks)[number]>();
    for (const c of checks) byPageEnv.set(`${c.pageUrl}\u0000${c.environment}`, c);
    return { pages, environments, byPageEnv };
  }, [session]);

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
          <Link
            to="/chat"
            className="btn btn-primary"
            onClick={() => sessionStorage.removeItem(SETUP_CONV_KEY)}
          >
            + New Exploration
          </Link>
        </div>
      </div>

      <div className="health-score-card">
        <div className={`health-score-grade grade-${report.healthScore.grade}`}>
          {report.healthScore.grade}
        </div>
        <div className="health-score-body">
          <h2>Site Health Score</h2>
          <span className="health-score-number">{report.healthScore.score}/100</span>
          <span className="health-score-summary">{report.healthScore.summary}</span>
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

      <FindingsChatPanel sessionId={session.id} />

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
                      : `${session.authProbe?.suggestedMethod ?? session.config.credentials?.type ?? 'unknown method'} — ${
                          session.authState === 'ready'
                            ? '✅ Authenticated'
                            : session.authState === 'awaiting_otp'
                              ? '⏸️ Waiting for OTP'
                              : session.authState === 'required'
                                ? '⚠️ Login failed — findings may reflect the login page'
                                : 'status unknown'
                        }`}
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

          {session.siteKnowledge && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Application Knowledge Base</h2>
              <p className="session-meta">
                Generated the first time this app CATEGORY was seen (by site type); reused silently for every other site that classifies into the same category.
              </p>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.9rem', lineHeight: 1.6 }}>
                {session.siteKnowledge}
              </pre>
            </section>
          )}

          {applicationMapGroups.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Application Map</h2>
              <p className="session-meta">Discovered routes grouped by top-level section:</p>
              {applicationMapGroups.map(([segment, paths]) => (
                <div key={segment} style={{ marginBottom: '0.5rem' }}>
                  <strong>/{segment}</strong>
                  <ul>
                    {paths.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {session.actionInventory && session.actionInventory.totalFound > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Action Inventory</h2>
              <p className="session-meta">
                Found <strong>{session.actionInventory.totalFound}</strong> distinct action
                element(s) (buttons, icon-buttons, menu items, tabs) — tested{' '}
                <strong>{session.actionInventory.totalTested}</strong>, skipped{' '}
                <strong>{session.actionInventory.totalSkippedRisky}</strong> as risky
                (delete/pay/send-style actions).
              </p>
              <table className="report-overview-table">
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(session.actionInventory.byResult).map(([result, count]) => (
                    <tr key={result}>
                      <td>{result}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {environmentMatrix && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Environment Comparison</h2>
              <p className="session-meta">
                Every page × browser/device combination actually checked this session, and whether it matched the baseline.
              </p>
              <table className="report-overview-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    {environmentMatrix.environments.map((env) => (
                      <th key={env}>{env}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {environmentMatrix.pages.map((pageUrl) => {
                    let shortUrl = pageUrl;
                    try {
                      shortUrl = new URL(pageUrl).pathname || '/';
                    } catch {
                      /* keep raw url */
                    }
                    return (
                      <tr key={pageUrl}>
                        <td>{shortUrl}</td>
                        {environmentMatrix.environments.map((env) => {
                          const c = environmentMatrix.byPageEnv.get(`${pageUrl}\u0000${env}`);
                          return (
                            <td key={env} title={c?.note ?? ''}>
                              {!c ? '—' : c.ok ? '✓' : '✗'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {session.accessMap && session.accessMap.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Access Map</h2>
              <p className="session-meta">
                UI-hidden links checked for direct reachability under the current session's authenticated role — not a
                cross-role comparison (that would need multiple real logins against a live account).
              </p>
              <table className="report-overview-table">
                <thead>
                  <tr>
                    <th>Feature/Link</th>
                    <th>Visible in UI</th>
                    <th>Directly Reachable</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {session.accessMap.map((e, i) => (
                    <tr key={i}>
                      <td>{e.feature}</td>
                      <td>✗</td>
                      <td>{e.directlyReachable ? '✓' : '✗'}</td>
                      <td>{e.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {session.findingDiff && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2>Regression vs Previous Run</h2>
              <p className="session-meta">
                Compared against the previous completed run against this target
                {session.findingDiff.previousSessionId
                  ? ` (session ${session.findingDiff.previousSessionId.slice(0, 8)})`
                  : ''}
                .
              </p>
              <div className="regression-diff-grid">
                <div>
                  <h3 style={{ fontSize: '1rem' }}>
                    New ({session.findingDiff.newFindings.length})
                  </h3>
                  {session.findingDiff.newFindings.length === 0 ? (
                    <p className="empty-state">None</p>
                  ) : (
                    <ul>
                      {session.findingDiff.newFindings.slice(0, 20).map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 style={{ fontSize: '1rem' }}>
                    Fixed ({session.findingDiff.fixedFindings.length})
                  </h3>
                  {session.findingDiff.fixedFindings.length === 0 ? (
                    <p className="empty-state">None</p>
                  ) : (
                    <ul>
                      {session.findingDiff.fixedFindings.slice(0, 20).map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {session.findingDiff.recurringFindings.length > 0 && (
                <>
                  <h3 style={{ fontSize: '1rem' }}>
                    Recurring ({session.findingDiff.recurringFindings.length})
                  </h3>
                  <ul>
                    {session.findingDiff.recurringFindings.slice(0, 20).map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

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
          <QualityPilotConnect />

          <h2>Findings ({sortedFindings.length})</h2>
          {sortedFindings.length === 0 ? (
            <p className="empty-state">No findings were recorded during this exploration.</p>
          ) : (
            <div className="findings-list">
              {sortedFindings.map((f: Finding) => (
                <FindingCard key={f.id} finding={f} sessionId={session.id} />
              ))}
            </div>
          )}
        </section>
      )}

      {view === 'markdown' && <pre className="report-markdown">{report.markdown}</pre>}
    </div>
  );
}
