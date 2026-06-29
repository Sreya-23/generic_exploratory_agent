import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { listSessions, clearSessions } from '../api/client';
import type { SessionState } from '../api/client';

export function HomePage() {
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  const handleClear = async () => {
    if (!confirm('Clear all session history and findings? This cannot be undone.')) return;
    setClearing(true);
    try {
      await clearSessions();
      setSessions([]);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="page home-page">
      <section className="hero">
        <h1>Generic Exploratory QA Agent</h1>
        <p>
          Intelligently explore any web application for edge cases, interruptions, API issues,
          and chaos scenarios — with or without a PRD.
        </p>
        <div className="hero-actions">
          <Link to="/chat" className="btn btn-primary">
            Start with Chat
          </Link>
          <Link to="/setup" className="btn btn-secondary">
            Classic Setup
          </Link>
        </div>
      </section>

      <section className="features">
        <div className="feature-card">
          <h3>💬 Chat Setup</h3>
          <p>Describe what to test in plain language — the agent configures the rest.</p>
        </div>
        <div className="feature-card">
          <h3>⚡ Chaos Testing</h3>
          <p>Back button mid-POST, offline recovery, double-submit on slow network.</p>
        </div>
        <div className="feature-card">
          <h3>📋 Live Reports</h3>
          <p>Stream findings in real-time. Export Markdown or HTML when done.</p>
        </div>
      </section>

      {sessions.length > 0 && (
        <section className="recent-sessions">
          <div className="sessions-header">
            <h2>Recent Sessions</h2>
            <button
              className="btn btn-danger btn-sm"
              onClick={handleClear}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : '🗑 Clear History'}
            </button>
          </div>
          <div className="session-list">
            {sessions.slice(0, 10).map((s) => (
              <div key={s.id} className="session-row">
                <div>
                  <strong>{s.config.targetUrl}</strong>
                  <span className={`status status-${s.status}`}>{s.status}</span>
                </div>
                <div className="session-meta">
                  {s.findings.length} findings · {s.config.depth}
                </div>
                <div className="session-actions">
                  <Link to={`/session/${s.id}`}>View</Link>
                  {s.status === 'completed' && <Link to={`/report/${s.id}`}>Report</Link>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
