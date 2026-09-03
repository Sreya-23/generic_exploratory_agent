import dotenv from 'dotenv';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { SessionConfig } from '@qa/shared';
import { EXPLORATION_AREAS, SESSION_DEPTHS } from '@qa/shared';
import { orchestrator } from '@qa/agent-core';
import { liveChatStore } from '@qa/chat-agent';
import { registerChatRoutes, bridgeSessionEventToChat, registerPrdAndReportRoutes } from './routes/chat.js';

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
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
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
    uploadPrd: 'POST /api/sessions/:id/upload-prd',
    setupUploadPrd: 'POST /api/chat/setup/upload-prd?conversationId=',
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

await registerChatRoutes(app);
registerPrdAndReportRoutes(app, SESSIONS_DIR);

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
    prdPath: config.prdPath,
    prdFilename: config.prdFilename,
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

app.post<{ Params: { id: string } }>(
  '/api/sessions/:id/upload-prd',
  async (req, reply) => {
    const session = orchestrator.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const filename = data.filename ?? 'prd.pdf';
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'pdf';
    if (!['pdf', 'md', 'txt'].includes(ext)) {
      return reply.status(400).send({
        error: 'Unsupported file type. Upload a .pdf, .md, or .txt PRD.',
      });
    }

    const prdPath = join(SESSIONS_DIR, req.params.id, `prd.${ext}`);
    await mkdir(join(SESSIONS_DIR, req.params.id), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(prdPath, buffer);

    session.config.prdPath = prdPath;
    session.config.prdFilename = filename;
    return { prdPath, filename };
  },
);


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
