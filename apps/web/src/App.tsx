import { Routes, Route } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { HomePage } from './pages/HomePage';
import { ChatSetupPage } from './pages/ChatSetupPage';
import { LiveSessionPage } from './pages/LiveSessionPage';
import { ReportPage } from './pages/ReportPage';

// The classic form-based setup (SessionSetupPage) is intentionally unrouted, not deleted — it
// still works as a component, just not linked or reachable from anywhere in the UI, since chat
// setup is the only flow actually in use. Re-add the route here if that ever changes.
export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/chat" element={<ChatSetupPage />} />
        <Route path="/session/:id" element={<LiveSessionPage />} />
        <Route path="/report/:id" element={<ReportPage />} />
      </Routes>
    </AppShell>
  );
}
