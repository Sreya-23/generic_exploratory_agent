import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();

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
          <Link to="/chat" className={location.pathname === '/chat' ? 'active' : ''}>
            Chat Setup
          </Link>
          <Link to="/setup" className={location.pathname === '/setup' ? 'active' : ''}>
            Form Setup
          </Link>
        </nav>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
