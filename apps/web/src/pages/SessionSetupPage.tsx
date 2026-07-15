import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExplorationArea, SessionDepth, SessionCredentials } from '@qa/shared';
import { createSession, fetchMeta, startSession, uploadPrd } from '../api/client';

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
  const [prdFile, setPrdFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof fetchMeta>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => {});
  }, []);

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

      if (prdFile) {
        await uploadPrd(session.id, prdFile);
      }

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
          <label>
            PRD file (optional — PDF recommended)
            <input
              type="file"
              accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown"
              onChange={(e) => setPrdFile(e.target.files?.[0] ?? null)}
            />
            <span className="field-hint">
              If provided, exploration runs <strong>PRD-only</strong>: happy path, negative/empty/invalid,
              and interruption tests for each extracted feature (generic matrix skipped).
            </span>
          </label>
          {prdFile && <p className="prd-upload-status prd-attached">Selected: {prdFile.name}</p>}
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
