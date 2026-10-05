import { useEffect, useState } from 'react';
import {
  getQualityPilotConfig,
  saveQualityPilotConfig,
  raiseBugsInQualityPilot,
  type QualityPilotConfig,
} from '../../api/client';

// Shared by both the live session page and the report page, so the connect flow works
// wherever the user happens to be looking at findings — no navigating to a specific page
// just to paste a token. Base URL/workspace/project are fixed for this QualityPilot instance
// and pre-filled as defaults; only the auth token is ever something the user re-enters, since
// QualityPilot has no long-lived API key, only ~1hr user session tokens.
export function QualityPilotConnect({ sessionId }: { sessionId: string }) {
  const [qpConfig, setQpConfig] = useState<QualityPilotConfig | null>(null);
  const [qpForm, setQpForm] = useState({
    baseUrl: 'http://localhost:8000/api/v1',
    workspaceId: 'c005f571-a1fb-40c4-a4be-f5f7690b88f6',
    projectId: '7ddaaa52-5c72-4ae9-8688-f9dda846a9b2',
    token: '',
  });
  const [qpEditing, setQpEditing] = useState(false);
  const [qpSaving, setQpSaving] = useState(false);
  const [raiseAllStatus, setRaiseAllStatus] = useState('');
  const [raiseAllBusy, setRaiseAllBusy] = useState(false);

  useEffect(() => {
    getQualityPilotConfig().then((c) => {
      setQpConfig(c);
      if (c) setQpForm(c);
    }).catch(() => {});
  }, []);

  const handleSaveQpConfig = async () => {
    setQpSaving(true);
    try {
      await saveQualityPilotConfig(qpForm);
      setQpConfig(qpForm);
      setQpEditing(false);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setQpSaving(false);
    }
  };

  const handleRaiseAll = async () => {
    setRaiseAllBusy(true);
    setRaiseAllStatus('');
    try {
      const result = await raiseBugsInQualityPilot(sessionId);
      setRaiseAllStatus(`Raised ${result.created} bug(s) in QualityPilot`);
    } catch (err) {
      setRaiseAllStatus((err as Error).message);
    } finally {
      setRaiseAllBusy(false);
    }
  };

  return (
    <div className="qp-integration" style={{ marginBottom: '1.5rem', padding: '1rem', border: '1px solid var(--border, #ccc)', borderRadius: '8px' }}>
      {qpConfig && !qpEditing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span className="session-meta">
            QualityPilot connected: {qpConfig.baseUrl} (workspace {qpConfig.workspaceId.slice(0, 8)}…)
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => setQpEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn btn-primary" onClick={handleRaiseAll} disabled={raiseAllBusy}>
            {raiseAllBusy ? 'Raising all…' : 'Raise all findings as bugs in QualityPilot'}
          </button>
          {raiseAllStatus && <span className="session-meta">{raiseAllStatus}</span>}
        </div>
      ) : (
        <div>
          <p className="session-meta" style={{ marginBottom: '0.5rem' }}>
            Paste the QualityPilot API key (from its backend's EXPLORATORY_AGENT_API_KEY) to connect. This is a one-time setup — unlike a login session token, this key doesn't expire.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              style={{ flex: 1 }}
              placeholder="Paste QualityPilot API key here"
              value={qpForm.token}
              onChange={(e) => setQpForm((f) => ({ ...f, token: e.target.value }))}
            />
          </div>
          <details style={{ marginBottom: '0.5rem' }}>
            <summary className="session-meta" style={{ cursor: 'pointer' }}>Advanced (base URL / workspace / project — already filled in, only change if connecting to a different QualityPilot instance)</summary>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                placeholder="Base URL"
                value={qpForm.baseUrl}
                onChange={(e) => setQpForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
              <input
                placeholder="Workspace ID"
                value={qpForm.workspaceId}
                onChange={(e) => setQpForm((f) => ({ ...f, workspaceId: e.target.value }))}
              />
              <input
                placeholder="Project ID"
                value={qpForm.projectId}
                onChange={(e) => setQpForm((f) => ({ ...f, projectId: e.target.value }))}
              />
            </div>
          </details>
          <button type="button" className="btn btn-primary" onClick={handleSaveQpConfig} disabled={qpSaving || !qpForm.token}>
            {qpSaving ? 'Saving…' : 'Connect'}
          </button>
          {qpConfig && (
            <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.5rem' }} onClick={() => setQpEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
