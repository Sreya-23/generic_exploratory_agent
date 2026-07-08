import { Routes, Route } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { HomePage } from './pages/HomePage';
import { ChatSetupPage } from './pages/ChatSetupPage';
import { SessionSetupPage } from './pages/SessionSetupPage';
import { LiveSessionPage } from './pages/LiveSessionPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/chat" element={<ChatSetupPage />} />
        <Route path="/setup" element={<SessionSetupPage />} />
        <Route path="/session/:id" element={<LiveSessionPage />} />
      </Routes>
    </AppShell>
  );
}
