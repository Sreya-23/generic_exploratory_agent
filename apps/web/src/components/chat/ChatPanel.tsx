import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@qa/shared';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  showStartButton?: boolean;
  onStart?: () => void;
  startLabel?: string;
  loading?: boolean;
}

function formatContent(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export function ChatPanel({
  messages,
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
  title = 'Chat',
  showStartButton = false,
  onStart,
  startLabel = 'Start Exploration',
  loading = false,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || disabled || loading) return;
    onSend(text);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h2>{title}</h2>
        {showStartButton && onStart && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onStart} disabled={loading}>
            {startLabel}
          </button>
        )}
      </div>

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble chat-${m.role} ${m.meta?.kind ? `chat-kind-${m.meta.kind}` : ''}`}>
            <div
              className="chat-content"
              dangerouslySetInnerHTML={{ __html: formatContent(m.content) }}
            />
            <time className="chat-time">
              {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-assistant chat-typing">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || loading}
          rows={2}
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
