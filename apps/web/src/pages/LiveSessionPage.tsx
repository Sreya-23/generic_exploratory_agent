import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChatMessage } from '@qa/shared';
import {
  connectSessionWs,
  getSession,
  getSessionChat,
  pauseSession,
  sendSessionChat,
  type Finding,
  type SessionState,
} from '../api/client';
import { FindingCard } from '../components/session/FindingCard';
import { SessionProgress } from '../components/session/SessionProgress';
import { ChatPanel } from '../components/chat/ChatPanel';

function applyEvent(
  event: { type: string; payload: unknown },
  setSession: Dispatch<SetStateAction<SessionState | null>>,
  setFindings: Dispatch<SetStateAction<Finding[]>>,
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
): void {
  if (event.type === 'chat:history') {
    setChatMessages(event.payload as ChatMessage[]);
    return;
  }

  if (event.type === 'chat:message') {
    const msg = event.payload as ChatMessage;
    setChatMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    return;
  }

  if (event.type === 'session:sync') {
    const s = event.payload as SessionState;
    setSession(s);
    setFindings(s.findings);
    return;
  }

  if (event.type === 'session:finding') {
    const finding = event.payload as Finding;
    setFindings((prev) => {
      if (prev.some((f) => f.id === finding.id)) return prev;
      return [...prev, finding];
    });
    return;
  }

  if (event.type === 'session:progress' || event.type === 'task:started' || event.type === 'task:completed') {
    setSession((prev) => {
      if (!prev) return prev;
      const payload = event.payload as SessionState['progress'] & { status?: SessionState['status']; currentTask?: string };
      if (event.type === 'task:started') {
        const task = payload as unknown as { title?: string };
        return {
          ...prev,
          status: 'running',
          progress: {
            ...prev.progress,
            currentTask: task.title ?? prev.progress.currentTask,
          },
        };
      }
      return {
        ...prev,
        status: payload.status ?? prev.status,
        progress: {
          ...prev.progress,
          ...payload,
        },
      };
    });
    return;
  }

  if (event.type === 'session:completed' || event.type === 'session:failed') {
    const s = event.payload as SessionState;
    setSession(s);
    setFindings(s.findings);
    return;
  }

  if (event.type === 'session:started') {
    setSession((prev) => (prev ? { ...prev, status: 'running' } : prev));
  }
}

export function LiveSessionPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionState | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>('connecting');
  const [loadError, setLoadError] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  useEffect(() => {
    if (!id) return;

    let active = true;

    const refresh = async () => {
      try {
        const s = await getSession(id);
        if (!active) return;
        setSession(s);
        setFindings(s.findings);
        setLoadError('');
      } catch {
        if (!active) return;
        setLoadError('Session not found. It may have expired after a server restart — start a new exploration.');
      }
    };

    getSessionChat(id)
      .then((msgs) => {
        if (active) setChatMessages(msgs);
      })
      .catch(() => {});

    refresh();

    const disconnect = connectSessionWs(
      id,
      (event) => applyEvent(event, setSession, setFindings, setChatMessages),
      setWsStatus,
    );

    const poll = setInterval(refresh, 2000);

    return () => {
      active = false;
      disconnect();
      clearInterval(poll);
    };
  }, [id]);

  const handleChatSend = useCallback(
    async (text: string) => {
      if (!id) return;
      setChatLoading(true);
      try {
        const result = await sendSessionChat(id, text);
        setChatMessages(result.messages);
        if (result.action === 'pause' || result.action === 'resume') {
          const s = await getSession(id);
          setSession(s);
        }
      } finally {
        setChatLoading(false);
      }
    },
    [id],
  );

  const handlePause = async () => {
    if (!id) return;
    await pauseSession(id);
    const s = await getSession(id);
    setSession(s);
  };

  if (loadError && !session) {
    return (
      <div className="page">
        <h1>Session Unavailable</h1>
        <p className="error-banner">{loadError}</p>
        <Link to="/chat" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>
          Start New Exploration
        </Link>
      </div>
    );
  }

  if (!session) {
    return <div className="page loading">Loading session...</div>;
  }

  const isActive = session.status === 'running' || session.status === 'planning';
  const awaitingAuth = session.status === 'awaiting_auth';

  return (
    <div className="page live-page">
      <div className="live-header">
        <div>
          <h1>Live Exploration</h1>
          <p className="target-url">{session.config.targetUrl}</p>
          <p className="connection-status">
            {awaitingAuth
              ? '🔐 Waiting for login credentials in chat'
              : wsStatus === 'connected'
                ? '🟢 Live'
                : wsStatus === 'error' || wsStatus === 'closed'
                  ? '🟡 Polling'
                  : '⏳ Connecting...'}
          </p>
        </div>
        <div className="live-actions">
          {isActive && (
            <button className="btn btn-secondary" onClick={handlePause}>
              Pause
            </button>
          )}
          {session.status === 'completed' && (
            <Link to={`/report/${id}`} className="btn btn-primary">
              View Report
            </Link>
          )}
        </div>
      </div>

      <SessionProgress session={session} />

      <div className="live-grid live-grid-chat">
        <section className="chat-section">
          <ChatPanel
            messages={chatMessages}
            onSend={handleChatSend}
            loading={chatLoading}
            disabled={false}
            placeholder={
              awaitingAuth
                ? 'email: you@co.com password: secret  — or  otp: 123456'
                : 'Ask "status", "show findings", or "pause"...'
            }
            title="Exploration Chat"
          />
        </section>

        <section className="findings-panel">
          <h2>Findings ({findings.length})</h2>
          {findings.length === 0 ? (
            <p className="empty-state">
              {isActive ? 'Exploring... findings will appear here.' : 'No findings recorded.'}
            </p>
          ) : (
            <div className="findings-list">
              {findings.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
