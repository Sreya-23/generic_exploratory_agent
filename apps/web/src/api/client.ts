import type {
  ExplorationArea,
  Finding,
  HealthScore,
  SessionConfig,
  SessionCredentials,
  SessionDepth,
  SessionEvent,
  SessionState,
} from '@qa/shared';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

function wsBase(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit.replace(/\/$/, '');

  if (API_BASE) {
    return API_BASE.replace(/^http/, 'ws');
  }

  // In dev, connect WebSocket directly to API — Vite WS proxy is unreliable
  if (import.meta.env.DEV) {
    return 'ws://localhost:3001';
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

export async function fetchMeta(): Promise<{
  areas: { id: ExplorationArea; label: string; description: string }[];
  depths: { id: SessionDepth; label: string; description: string; estimatedMinutes: number }[];
}> {
  const res = await fetch(`${API_BASE}/api/meta`);
  if (!res.ok) throw new Error('Failed to load metadata');
  return res.json();
}

export async function createSession(config: SessionConfig): Promise<SessionState> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

export async function startSession(id: string): Promise<SessionState> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}/start`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to start session');
  return res.json();
}

export async function pauseSession(id: string): Promise<SessionState> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to pause session');
  return res.json();
}

export async function getSession(id: string): Promise<SessionState> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`);
  if (!res.ok) throw new Error('Session not found');
  return res.json();
}

export async function listSessions(): Promise<SessionState[]> {
  const res = await fetch(`${API_BASE}/api/sessions`);
  if (!res.ok) throw new Error('Failed to list sessions');
  return res.json();
}

export async function clearSessions(): Promise<void> {
  await fetch(`${API_BASE}/api/sessions`, { method: 'DELETE' });
}

export async function uploadPrd(sessionId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/upload-prd`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to upload PRD');
  }
}

export async function fetchSessionReport(
  sessionId: string,
  format: 'md' | 'json' = 'md',
): Promise<string | { reportMarkdown: string; prdCoverage: unknown }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/report?format=${format}`);
  if (!res.ok) throw new Error('Failed to load report');
  if (format === 'json') return res.json();
  return res.text();
}

export function connectSessionWs(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  onStatus?: (status: 'connecting' | 'connected' | 'error' | 'closed') => void,
): () => void {
  const wsUrl = `${wsBase()}/api/sessions/${sessionId}/ws`;
  let closed = false;
  let ws: WebSocket;

  const connect = () => {
    onStatus?.('connecting');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => onStatus?.('connected');

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as SessionEvent;
        onEvent(event);
      } catch {
        /* ignore */
      }
    };

    ws.onerror = () => onStatus?.('error');

    ws.onclose = () => {
      if (!closed) onStatus?.('closed');
    };
  };

  connect();

  return () => {
    closed = true;
    ws?.close();
  };
}

let setupInitPromise: Promise<import('@qa/shared').SetupChatResponse> | null = null;

export async function initSetupChat(
  conversationId?: string,
): Promise<import('@qa/shared').SetupChatResponse> {
  if (!conversationId && setupInitPromise) return setupInitPromise;

  const url = conversationId
    ? `${API_BASE}/api/chat/setup?conversationId=${encodeURIComponent(conversationId)}`
    : `${API_BASE}/api/chat/setup`;

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error('Failed to init chat');
      return res.json() as Promise<import('@qa/shared').SetupChatResponse>;
    })
    .finally(() => {
      if (!conversationId) setupInitPromise = null;
    });

  if (!conversationId) setupInitPromise = promise;
  return promise;
}

export async function sendSetupChat(body: {
  conversationId?: string;
  message: string;
}): Promise<import('@qa/shared').SetupChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Failed to send message');
  }
  return res.json();
}

export async function getSessionChat(sessionId: string): Promise<import('@qa/shared').ChatMessage[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/chat`);
  if (!res.ok) throw new Error('Failed to load chat');
  const data = await res.json();
  return data.messages;
}

export async function sendSessionChat(
  sessionId: string,
  message: string,
): Promise<{ messages: import('@qa/shared').ChatMessage[]; action?: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error('Failed to send message');
  return res.json();
}

export async function submitCredentials(
  sessionId: string,
  credentials: SessionCredentials,
): Promise<import('@qa/shared').SessionState> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) throw new Error('Failed to submit credentials');
  return res.json();
}

export async function probeUrl(
  url: string,
  conversationId?: string,
): Promise<import('@qa/shared').AuthProbeResult | import('@qa/shared').SetupChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, conversationId }),
  });
  if (!res.ok) throw new Error('Probe failed');
  return res.json();
}

export async function getSessionReport(id: string): Promise<SessionReportPayload> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}/report`);
  if (!res.ok) throw new Error('Report not found');
  return res.json();
}

export function reportDownloadUrl(id: string, format: 'md' | 'html'): string {
  return `${API_BASE}/api/sessions/${id}/report?format=${format}`;
}

export async function askAboutFindings(sessionId: string, question: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error('Failed to get an answer');
  const data = (await res.json()) as { answer: string };
  return data.answer;
}

export interface SessionReportPayload {
  sessionId: string;
  status: string;
  total: number;
  bySeverity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
  healthScore: HealthScore;
  executiveSummary: string;
  recommendedNextSteps: string[];
  markdown: string;
  html: string;
  findings: Finding[];
  flowsCovered?: {
    area: string;
    flowClass: string;
    title: string;
    description: string;
    findingsCount: number;
    steps?: string[];
  }[];
  findingsByArea?: {
    area: string;
    count: number;
    bySeverity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
  }[];
}

export type { Finding, SessionState, SessionConfig };
