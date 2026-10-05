import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SETUP_CONV_KEY } from '../../pages/ChatSetupPage';

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  // /chat resumes whatever setup conversation is cached in sessionStorage — without clearing
  // it first, typing a new target URL mid-conversation carries over the PREVIOUS site's
  // credentials/auth method instead of asking fresh for the new one. Every entry point into
  // chat setup from the persistent header must reset this, not just the completed-session
  // "start over" links, since a user can want a clean start from anywhere.
  const startNewSession = () => sessionStorage.removeItem(SETUP_CONV_KEY);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="logo">
          <span className="logo-icon">🔍</span>
          Exploratory QA Agent
        </Link>
        <nav className="app-nav">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
            Home
          </Link>
          <Link
            to="/chat"
            className={location.pathname === '/chat' ? 'active' : ''}
            onClick={startNewSession}
          >
            Chat Setup
          </Link>
        </nav>
        <Link to="/chat" className="btn btn-primary btn-sm new-session-btn" onClick={startNewSession}>
          + New Session
        </Link>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
