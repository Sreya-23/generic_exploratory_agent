import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage, SetupChatResponse } from '@qa/shared';
import { ChatPanel } from '../components/chat/ChatPanel';
import { createSession, sendSetupChat, initSetupChat, startSession } from '../api/client';

const SETUP_CONV_KEY = 'qa-setup-conversation-id';

export function ChatSetupPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [, setConversationId] = useState<string>();
  const [readyToStart, setReadyToStart] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [draftSummary, setDraftSummary] = useState('');
  const conversationIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const storedId = sessionStorage.getItem(SETUP_CONV_KEY) ?? undefined;
    initSetupChat(storedId)
      .then((res) => {
        if (cancelled) return;
        sessionStorage.setItem(SETUP_CONV_KEY, res.conversationId);
        conversationIdRef.current = res.conversationId;
        applyResponse(res);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([
          {
            id: 'err',
            role: 'assistant',
            content: 'Could not connect to the agent. Is the API running on port 3001?',
            timestamp: new Date().toISOString(),
          },
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyResponse = (res: SetupChatResponse) => {
    conversationIdRef.current = res.conversationId;
    sessionStorage.setItem(SETUP_CONV_KEY, res.conversationId);
    setConversationId(res.conversationId);
    setMessages(res.messages);
    setReadyToStart(res.readyToStart);
    if (res.draft.targetUrl) {
      setDraftSummary(
        `${res.draft.targetUrl} · ${res.draft.depth} · ${res.draft.areas.join(', ')}`,
      );
    }
  };

  const handleSend = useCallback(async (text: string) => {
    if (text === '__init__') return;
    if (!conversationIdRef.current) return;
    setLoading(true);
    try {
      const res = await sendSetupChat({ conversationId: conversationIdRef.current, message: text });
      applyResponse(res);

      if (res.readyToStart && res.config) {
        await handleStart(res);
      }
    } catch (err) {
      if ((err as Error).message.includes('Failed to send message')) {
        try {
          const fresh = await initSetupChat();
          conversationIdRef.current = fresh.conversationId;
          applyResponse(fresh);
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: 'assistant',
              content: 'Session expired (API may have restarted). Please send your URL again.',
              timestamp: new Date().toISOString(),
            },
          ]);
        } catch {
          /* ignore */
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleStart = async (res?: SetupChatResponse) => {
    setStarting(true);
    try {
      let config = res?.config;
      if (!config) {
        const latest = await sendSetupChat({ conversationId: conversationIdRef.current, message: 'start' });
        config = latest.config;
        applyResponse(latest);
        if (!config) return;
      }

      const session = await createSession(config);
      navigate(`/session/${session.id}`);
      await startSession(session.id);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Failed to start: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="page chat-setup-page">
      <div className="chat-setup-header">
        <div>
          <h1>Exploratory QA Chat</h1>
          <p className="subtitle">
            Describe what to test in plain language — I'll configure the exploration for you.
          </p>
          {draftSummary && <p className="draft-summary">{draftSummary}</p>}
        </div>
        <a href="/setup" className="form-link">
          Prefer a form? Use classic setup →
        </a>
      </div>

      <ChatPanel
        messages={messages}
        onSend={handleSend}
        loading={loading || starting}
        placeholder='e.g. "https://myapp.com" then username, then password when asked'
        title="Setup Assistant"
        showStartButton={readyToStart}
        onStart={() => handleStart()}
        startLabel={starting ? 'Starting...' : 'Start Exploration'}
      />
    </div>
  );
}
