import 'dotenv/config';
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
import { orchestrator, generateMarkdownReport } from '@qa/agent-core';
import { liveChatStore } from '@qa/chat-agent';
import { registerChatRoutes, bridgeSessionEventToChat } from './routes/chat.js';
import { readFile } from 'node:fs/promises';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(ROOT, 'sessions');
const PORT = Number(process.env.API_PORT ?? 3001);

await mkdir(SESSIONS_DIR, { recursive: true });

// Clear stale session folders on startup so old results don't bleed into new runs
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
await clearSessionsDir();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
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
    liveUpdates: 'WS /api/sessions/:id/ws',
    chatSetup: 'POST /api/chat/setup',
    sessionChat: 'GET|POST /api/sessions/:id/chat',
    report: 'GET /api/sessions/:id/report?format=md|html|json',
  },
  note: 'Open the Web UI at http://localhost:5173 to start an exploration.',
}));

app.get('/api/meta', async () => ({
  areas: EXPLORATION_AREAS,
  depths: SESSION_DEPTHS,
}));

await registerChatRoutes(app);

app.get('/api/sessions', async () => orchestrator.listSessions());

app.delete('/api/sessions', async () => {
  orchestrator.clearAll();
  await clearSessionsDir();
  return { cleared: true };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const session = orchestrator.getSession(req.params.id);
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
    const ext = data.filename?.split('.').pop() ?? 'txt';
    const prdPath = join(SESSIONS_DIR, req.params.id, `prd.${ext}`);
    await mkdir(join(SESSIONS_DIR, req.params.id), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(prdPath, buffer);

    session.config.prdPath = prdPath;
    return { prdPath, filename: data.filename };
  },
);

app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
  '/api/sessions/:id/report',
  async (req, reply) => {
    const session = orchestrator.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const format = req.query.format ?? 'json';

    if (format === 'md') {
      const md = generateMarkdownReport(session);
      reply.type('text/markdown');
      return md;
    }

    if (format === 'html') {
      try {
        const html = await readFile(join(SESSIONS_DIR, req.params.id, 'report.html'), 'utf-8');
        reply.type('text/html');
        return html;
      } catch {
        return reply.status(404).send({ error: 'Report not generated yet' });
      }
    }

    return {
      session,
      findings: session.findings,
      reportUrl: `/api/sessions/${req.params.id}/report?format=md`,
    };
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
