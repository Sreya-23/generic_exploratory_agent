import { useState } from 'react';
import { askAboutFindings } from '../../api/client';

interface QaTurn {
  question: string;
  answer: string;
}

const SUGGESTIONS = ['Summarize', 'Riskiest issue', 'Critical issues', 'Health score'];

export function FindingsChatPanel({ sessionId }: { sessionId: string }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ask = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError('');
    try {
      const answer = await askAboutFindings(sessionId, trimmed);
      setTurns((prev) => [...prev, { question: trimmed, answer }]);
      setQuestion('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="findings-chat-panel">
      <h2>Ask about this session</h2>

      {turns.length > 0 && (
        <div className="findings-chat-history">
          {turns.map((t, i) => (
            <div key={i} className="findings-chat-turn">
              <div className="findings-chat-question">{t.question}</div>
              <div className="findings-chat-answer">{t.answer}</div>
            </div>
          ))}
        </div>
      )}

      <div className="findings-chat-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip-btn" onClick={() => ask(s)} disabled={loading}>
            {s}
          </button>
        ))}
      </div>

      <form
        className="findings-chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. what's the riskiest issue?"
          disabled={loading}
        />
        <button type="submit" className="btn btn-primary" disabled={loading || !question.trim()}>
          {loading ? '…' : 'Ask'}
        </button>
      </form>

      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}
