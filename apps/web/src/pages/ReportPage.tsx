import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchReportMarkdown, getSession, type SessionState } from '../api/client';

export function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionState | null>(null);
  const [markdown, setMarkdown] = useState('');

  useEffect(() => {
    if (!id) return;
    getSession(id).then(setSession);
    fetchReportMarkdown(id).then(setMarkdown).catch(() => {});
  }, [id]);

  const downloadMd = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-report-${id}.md`;
    a.click();
  };

  const downloadHtml = () => {
    window.open(`/api/sessions/${id}/report?format=html`, '_blank');
  };

  if (!session) return <div className="page loading">Loading report...</div>;

  const bySeverity = {
    critical: session.findings.filter((f) => f.severity === 'critical').length,
    high: session.findings.filter((f) => f.severity === 'high').length,
    medium: session.findings.filter((f) => f.severity === 'medium').length,
    low: session.findings.filter((f) => f.severity === 'low').length,
    info: session.findings.filter((f) => f.severity === 'info').length,
  };

  return (
    <div className="page report-page">
      <div className="report-header">
        <div>
          <h1>Exploration Report</h1>
          <p>{session.config.targetUrl}</p>
        </div>
        <div className="report-actions">
          <button className="btn btn-secondary" onClick={downloadMd}>
            Download Markdown
          </button>
          <button className="btn btn-secondary" onClick={downloadHtml}>
            Open HTML
          </button>
          <Link to={`/session/${id}`} className="btn btn-primary">
            Back to Session
          </Link>
        </div>
      </div>

      <div className="severity-summary">
        <div className="severity-chip critical">{bySeverity.critical} Critical</div>
        <div className="severity-chip high">{bySeverity.high} High</div>
        <div className="severity-chip medium">{bySeverity.medium} Medium</div>
        <div className="severity-chip low">{bySeverity.low} Low</div>
        <div className="severity-chip info">{bySeverity.info} Info</div>
      </div>

      <pre className="report-markdown">{markdown || 'Report generating...'}</pre>
    </div>
  );
}
