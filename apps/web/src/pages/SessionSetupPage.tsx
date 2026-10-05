import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExplorationArea, SessionDepth, SessionCredentials } from '@qa/shared';
import {
  createSession,
  fetchMeta,
  startSession,
  getSavedCredentials,
  saveCredentialAs,
  deleteSavedCredential,
  type SavedCredential,
} from '../api/client';

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function SessionSetupPage() {
  const navigate = useNavigate();
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [context, setContext] = useState('');
  const [depth, setDepth] = useState<SessionDepth>('smoke');
  const [areas, setAreas] = useState<ExplorationArea[]>(['ui', 'chaos']);
  const [credentialType, setCredentialType] = useState<SessionCredentials['type']>('none');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authMethod, setAuthMethod] = useState<'password' | 'otp' | 'password-otp'>('password');
  const [otp, setOtp] = useState('');
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof fetchMeta>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [savedCredentials, setSavedCredentials] = useState<Record<string, SavedCredential>>({});
  const [selectedRole, setSelectedRole] = useState('');
  const [saveAsRole, setSaveAsRole] = useState('');
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => {});
  }, []);

  const hostname = useMemo(() => hostnameOf(targetUrl), [targetUrl]);

  // Re-fetch saved logins whenever the target's hostname changes — a site may have several
  // saved roles (different accounts/phone numbers), so this only asks "what's known for THIS
  // host", not a global list.
  useEffect(() => {
    if (!hostname) {
      setSavedCredentials({});
      return;
    }
    let active = true;
    getSavedCredentials(hostname)
      .then((creds) => {
        if (active) setSavedCredentials(creds);
      })
      .catch(() => {
        if (active) setSavedCredentials({});
      });
    return () => {
      active = false;
    };
  }, [hostname]);

  const applySavedRole = (role: string) => {
    setSelectedRole(role);
    const cred = savedCredentials[role];
    if (!cred) return;
    setCredentialType('login');
    if (cred.username !== undefined) setUsername(cred.username);
    if (cred.password !== undefined) setPassword(cred.password);
    if (cred.authMethod) setAuthMethod(cred.authMethod as typeof authMethod);
    // OTP is deliberately never saved/restored — it's a fresh code every login, not a
    // reusable credential.
  };

  const handleSaveAsRole = async () => {
    if (!hostname || !saveAsRole.trim()) return;
    await saveCredentialAs(hostname, saveAsRole.trim(), { username, password, authMethod });
    setSavedCredentials(await getSavedCredentials(hostname));
    setSaveStatus(`Saved as "${saveAsRole.trim()}"`);
    setSaveAsRole('');
    setTimeout(() => setSaveStatus(''), 3000);
  };

  const handleDeleteRole = async (role: string) => {
    if (!hostname) return;
    await deleteSavedCredential(hostname, role);
    setSavedCredentials(await getSavedCredentials(hostname));
    if (selectedRole === role) setSelectedRole('');
  };

  const toggleArea = (area: ExplorationArea) => {
    setAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const credentials: SessionCredentials = { type: credentialType };
      if (credentialType === 'login') {
        credentials.username = username;
        credentials.password = password;
        credentials.otp = otp;
        credentials.authMethod = authMethod;
      } else if (credentialType === 'api-key') {
        credentials.apiKey = apiKey;
      } else if (credentialType === 'bearer') {
        credentials.bearerToken = apiKey;
      }

      const session = await createSession({
        targetUrl,
        context: context || undefined,
        depth,
        areas: areas.length ? areas : ['ui'],
        credentials,
      });

      // Navigate first so live page connects WebSocket before exploration starts
      navigate(`/session/${session.id}`);
      await startSession(session.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page setup-page">
      <h1>New Exploration Session</h1>
      <p className="subtitle">Enter a target URL — no API tokens needed for public sites.</p>

      <form onSubmit={handleSubmit} className="setup-form">
        <section className="form-section">
          <h2>Target</h2>
          <label>
            Site URL *
            <input
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://your-app.com"
              required
            />
          </label>
          <label>
            Context (optional)
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Describe what this app does, key flows, user roles..."
              rows={4}
            />
          </label>
        </section>

        <section className="form-section">
          <h2>Credentials</h2>
          <div className="credential-types">
            {(['none', 'login', 'api-key', 'bearer'] as const).map((t) => (
              <label key={t} className="radio-label">
                <input
                  type="radio"
                  name="credType"
                  checked={credentialType === t}
                  onChange={() => setCredentialType(t)}
                />
                {t === 'none' ? 'Public (no login)' : t}
              </label>
            ))}
          </div>
          {credentialType === 'login' && (
            <div className="cred-fields">
              {Object.keys(savedCredentials).length > 0 && (
                <label>
                  Use a saved login for {hostname}
                  <select value={selectedRole} onChange={(e) => applySavedRole(e.target.value)}>
                    <option value="">— pick a saved role —</option>
                    {Object.keys(savedCredentials).map((role) => (
                      <option key={role} value={role}>
                        {role} {savedCredentials[role].username ? `(${savedCredentials[role].username})` : ''}
                      </option>
                    ))}
                  </select>
                  {selectedRole && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ marginTop: '0.5rem' }}
                      onClick={() => handleDeleteRole(selectedRole)}
                    >
                      Forget "{selectedRole}"
                    </button>
                  )}
                </label>
              )}
              <label>
                Auth method
                <select
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}
                >
                  <option value="password">Username + Password</option>
                  <option value="otp">OTP / Verification code</option>
                  <option value="password-otp">Password then OTP</option>
                </select>
              </label>
              <label>
                Username / Email
                <input value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              {(authMethod === 'password' || authMethod === 'password-otp') && (
                <label>
                  Password
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
              {(authMethod === 'otp' || authMethod === 'password-otp') && (
                <label>
                  OTP code
                  <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" />
                </label>
              )}
              {hostname && (username || password) && (
                <div className="cred-save-as" style={{ marginTop: '0.5rem' }}>
                  <label>
                    Save this login as a role (e.g. "admin", "user") — OTP is never saved, only username/password/auth method
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        value={saveAsRole}
                        onChange={(e) => setSaveAsRole(e.target.value)}
                        placeholder="role name"
                      />
                      <button type="button" className="btn btn-secondary" onClick={handleSaveAsRole}>
                        Save
                      </button>
                    </div>
                  </label>
                  {saveStatus && <span className="session-meta">{saveStatus}</span>}
                </div>
              )}
            </div>
          )}
          {(credentialType === 'api-key' || credentialType === 'bearer') && (
            <label>
              {credentialType === 'bearer' ? 'Bearer Token' : 'API Key'}
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
          )}
        </section>

        <section className="form-section">
          <h2>Exploration Depth</h2>
          <div className="depth-options">
            {(meta?.depths ?? []).map((d) => (
              <label key={d.id} className={`depth-card ${depth === d.id ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="depth"
                  checked={depth === d.id}
                  onChange={() => setDepth(d.id)}
                />
                <strong>{d.label}</strong>
                <span>{d.description}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="form-section">
          <h2>Areas to Explore</h2>
          <div className="area-grid">
            {(meta?.areas ?? []).map((a) => (
              <label key={a.id} className={`area-card ${areas.includes(a.id) ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={areas.includes(a.id)}
                  onChange={() => toggleArea(a.id)}
                />
                <strong>{a.label}</strong>
                <span>{a.description}</span>
              </label>
            ))}
          </div>
        </section>

        {error && <div className="error-banner">{error}</div>}

        <button type="submit" className="btn btn-primary btn-lg" disabled={loading}>
          {loading ? 'Starting...' : 'Start Exploration'}
        </button>
      </form>
    </div>
  );
}
