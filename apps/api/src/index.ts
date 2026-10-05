import dotenv from 'dotenv';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { SessionConfig } from '@qa/shared';
import { EXPLORATION_AREAS, SESSION_DEPTHS } from '@qa/shared';
import { orchestrator } from '@qa/agent-core';
import { liveChatStore } from '@qa/chat-agent';
import { registerChatRoutes, bridgeSessionEventToChat, registerReportRoutes } from './routes/chat.js';
import { loadCredentialsForHost, saveCredential, deleteCredential, type SavedCredential } from './credentials-store.js';
import { loadQualityPilotConfig, saveQualityPilotConfig, raiseFindingsInQualityPilot, type QualityPilotConfig } from './qualitypilot-integration.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../..');
// `import 'dotenv/config'` resolves .env relative to process.cwd() — but npm sets cwd to
// THIS WORKSPACE's own directory (apps/api/) when running a per-workspace script, not the
// repo root where the actual .env file lives. That silently no-ops (dotenv doesn't throw on
// a missing file), so every env var meant to come from the root .env — GEMINI_API_KEY
// included — was never actually loaded, no matter what the file said. Pointing dotenv at
// an explicit, cwd-independent path fixes this for good.
dotenv.config({ path: join(ROOT, '.env') });
// resolve() (not a bare join/fallback) so a relative value from .env — e.g. the
// "./sessions" in .env.example, meant relative to the repo root — still resolves to an
// absolute path. @fastify/static requires an absolute root, and this only "worked" before
// by accident: dotenv wasn't actually loading .env at all (see comment above), so this
// always silently fell through to the already-absolute default instead.
const SESSIONS_DIR = resolve(ROOT, process.env.SESSIONS_DIR ?? 'sessions');
const PORT = Number(process.env.API_PORT ?? 3001);

await mkdir(SESSIONS_DIR, { recursive: true });

// Deletes every session folder on disk. Only called from two places: the opt-in startup
// sweep below (gated — see its caller) and the explicit DELETE /api/sessions route, where
// wiping files is exactly what the user asked for and should always happen regardless of the
// startup gate.
async function clearSessionsDir(): Promise<void> {
  try {
    const entries = await readdir(SESSIONS_DIR);
    await Promise.all(
      entries.map((entry) =>
        rm(join(SESSIONS_DIR, entry), { recursive: true, force: true }),
      ),
    );
  } catch {
    /* ignore if dir is empty or missing */
  }
}
// Opt-in only — see clearSessionsDir's doc comment for why this used to run unconditionally
// and silently destroyed real session data on every dev-server restart.
if (process.env.CLEAR_SESSIONS_ON_START === '1') {
  await clearSessionsDir();
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

await app.register(fastifyStatic, {
  root: SESSIONS_DIR,
  prefix: '/sessions-files/',
  decorateReply: false,
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/', async () => ({
  name: 'Generic Exploratory QA Agent API',
  status: 'running',
  ui: 'http://localhost:5173',
  endpoints: {
    health: 'GET /health',
    meta: 'GET /api/meta',
    sessions: 'GET /api/sessions',
    createSession: 'POST /api/sessions',
    startSession: 'POST /api/sessions/:id/start',
    report: 'GET /api/sessions/:id/report?format=md|json',
    liveUpdates: 'WS /api/sessions/:id/ws',
    chatSetup: 'POST /api/chat/setup',
    sessionChat: 'GET|POST /api/sessions/:id/chat',
  },
  note: 'Open the Web UI at http://localhost:5173 to start an exploration.',
}));

app.get('/api/meta', async () => ({
  areas: EXPLORATION_AREAS,
  depths: SESSION_DEPTHS,
}));

// Saved logins per site/role — see credentials-store.ts. Local single-user tool, so returning
// the full saved credential (including password, when present) is fine: the exposure surface
// is the same machine that already holds credentials.json on disk.
app.get<{ Querystring: { hostname?: string } }>('/api/credentials', async (req, reply) => {
  if (!req.query.hostname) return reply.status(400).send({ error: 'hostname query param is required' });
  return loadCredentialsForHost(ROOT, req.query.hostname);
});

app.post<{ Querystring: { hostname?: string }; Body: { role: string } & SavedCredential }>(
  '/api/credentials',
  async (req, reply) => {
    const { hostname } = req.query;
    const { role, ...credential } = req.body;
    if (!hostname || !role) return reply.status(400).send({ error: 'hostname query param and role are required' });
    await saveCredential(ROOT, hostname, role, credential);
    return { saved: true };
  },
);

app.delete<{ Querystring: { hostname?: string; role?: string } }>('/api/credentials', async (req, reply) => {
  const { hostname, role } = req.query;
  if (!hostname || !role) return reply.status(400).send({ error: 'hostname and role query params are required' });
  await deleteCredential(ROOT, hostname, role);
  return { deleted: true };
});

// QualityPilot integration — one saved connection (base URL, workspace/project, auth token),
// not per-session. See qualitypilot-integration.ts for why the token has no refresh mechanism.
app.get('/api/integrations/qualitypilot', async () => {
  const config = await loadQualityPilotConfig(ROOT);
  return config ?? { configured: false };
});

app.post<{ Body: QualityPilotConfig }>('/api/integrations/qualitypilot', async (req, reply) => {
  const { baseUrl, workspaceId, projectId, token } = req.body;
  if (!baseUrl || !workspaceId || !projectId || !token) {
    return reply.status(400).send({ error: 'baseUrl, workspaceId, projectId, and token are all required' });
  }
  await saveQualityPilotConfig(ROOT, { baseUrl, workspaceId, projectId, token });
  return { saved: true };
});

app.post<{ Params: { id: string }; Body: { findingIds?: string[] } }>(
  '/api/sessions/:id/raise-bugs',
  async (req, reply) => {
    const session = await orchestrator.getSessionOrRehydrate(req.params.id, SESSIONS_DIR);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const config = await loadQualityPilotConfig(ROOT);
    if (!config) return reply.status(400).send({ error: 'QualityPilot is not configured yet — set it up first.' });

    const { findingIds } = req.body;
    // Info-severity findings are never real defects (see generate-report.ts's own split) —
    // excluded even if explicitly requested, same discipline as the report's own bug list.
    const candidates = session.findings.filter((f) => f.severity !== 'info');
    const findings = findingIds?.length
      ? candidates.filter((f) => findingIds.includes(f.id))
      : candidates;

    if (findings.length === 0) {
      return reply.status(400).send({ error: 'No eligible findings to raise (info-severity findings are excluded).' });
    }

    const result = await raiseFindingsInQualityPilot(config, session, findings);
    if (!result.ok) return reply.status(502).send({ error: result.error });
    return result.result;
  },
);

await registerChatRoutes(app);
registerReportRoutes(app, SESSIONS_DIR);

app.get('/api/sessions', async () => orchestrator.listSessions());

app.delete('/api/sessions', async () => {
  orchestrator.clearAll();
  await clearSessionsDir();
  return { cleared: true };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const session = await orchestrator.getSessionOrRehydrate(req.params.id, SESSIONS_DIR);
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  return session;
});

app.post<{ Body: SessionConfig }>('/api/sessions', async (req) => {
  const config = req.body;
  if (!config.targetUrl) {
    throw new Error('targetUrl is required');
  }
  const session = orchestrator.createSession({
    targetUrl: config.targetUrl,
    context: config.context,
    depth: config.depth ?? 'smoke',
    areas: config.areas?.length ? config.areas : ['ui'],
    credentials: config.credentials ?? { type: 'none' },
    openApiUrl: config.openApiUrl,
    flowInstructions: config.flowInstructions,
    selectedFlowClasses: config.selectedFlowClasses,
  });
  return session;
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/start', async (req, reply) => {
  const session = orchestrator.getSession(req.params.id);
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  liveChatStore.initSession(req.params.id, session.config.targetUrl);
  await orchestrator.startSession(req.params.id, SESSIONS_DIR);
  return orchestrator.getSession(req.params.id);
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/pause', async (req, reply) => {
  const session = orchestrator.getSession(req.params.id);
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  orchestrator.pauseSession(req.params.id);
  return orchestrator.getSession(req.params.id);
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/ws', { websocket: true }, (socket, req) => {
  const sessionId = req.params.id;
  const session = orchestrator.getSession(sessionId);

  if (!session) {
    socket.send(JSON.stringify({ type: 'error', payload: 'Session not found' }));
    socket.close();
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'session:sync',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: session,
    }),
  );

  const chatHistory = liveChatStore.getHistory(sessionId);
  if (chatHistory.length > 0) {
    socket.send(
      JSON.stringify({
        type: 'chat:history',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: chatHistory,
      }),
    );
  }

  const unsubscribe = orchestrator.subscribe(sessionId, (event) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(event));
      const chatEvent = bridgeSessionEventToChat(event);
      if (chatEvent) {
        socket.send(JSON.stringify(chatEvent));
      }
    }
  });

  socket.on('close', () => unsubscribe());
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`QA API running at http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
