import type { FastifyInstance } from 'fastify';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getOrCreateSetupConversation,
  processSetupMessage,
  applyProbeToConversation,
  attachPrdToSetupConversation,
  liveChatStore,
  processLiveMessage,
  sessionEventToChatMessage,
  answerFindingsQuestion,
} from '@qa/chat-agent';
import { probeAuth } from '@qa/explorer-ui';
import type { SessionCredentials, SessionEvent } from '@qa/shared';
import { orchestrator, generateSessionReportMarkdown, generateSessionReport, writeSessionReport } from '@qa/agent-core';

function extractUrlFromMessage(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return undefined;
  return match[0].replace(/[.,;:!?)]+$/, '');
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { conversationId?: string; message: string } }>(
    '/api/chat/setup',
    async (req, reply) => {
      const { conversationId, message } = req.body;
      if (!message?.trim()) {
        return reply.status(400).send({ error: 'message is required' });
      }

      let conversation;
      try {
        conversation = getOrCreateSetupConversation(conversationId);
      } catch (err) {
        return reply.status(404).send({ error: (err as Error).message });
      }

      const response = processSetupMessage(conversation, message);
      const urlInMessage = extractUrlFromMessage(message);
      const shouldProbe = !!urlInMessage && !conversation.draft.authProbe;

      if (shouldProbe && urlInMessage) {
        try {
          const probe = await probeAuth(urlInMessage);
          return applyProbeToConversation(conversation, probe);
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          const looksLikeMissingBrowser =
            /Executable doesn't exist|playwright install|browserType\.launch/i.test(msg);
          conversation.draft.targetUrl = urlInMessage;
          conversation.messages.push({
            id: `probe-err-${Date.now()}`,
            role: 'assistant',
            content: looksLikeMissingBrowser
              ? `⚠️ I saved your URL (**${urlInMessage}**), but couldn't open a browser to auto-detect login.\n\n` +
                `Playwright Chromium is missing. On the server, run:\n\`\`\`\nnpx playwright install chromium\n\`\`\`\n` +
                `Then restart \`npm run dev\` and send the URL again.\n\n` +
                `Meanwhile you can still continue: tell me if login is needed, e.g. \`username: standard_user password: secret_sauce\`.`
              : `⚠️ I saved your URL (**${urlInMessage}**), but auth probe failed:\n\`${msg.slice(0, 200)}\`\n\n` +
                `You can continue manually — provide credentials if needed, then say **start**.`,
            timestamp: new Date().toISOString(),
            meta: { kind: 'setup' },
          });
          return {
            conversationId: conversation.id,
            messages: conversation.messages,
            draft: conversation.draft,
            readyToStart: false,
            missing: conversation.draft.targetUrl ? [] : ['target URL'],
          };
        }
      }

      return response;
    },
  );

  app.post<{ Body: { url: string; conversationId?: string } }>(
    '/api/chat/probe',
    async (req, reply) => {
      const { url, conversationId } = req.body;
      if (!url?.trim()) return reply.status(400).send({ error: 'url is required' });

      const probe = await probeAuth(url.trim());
      if (conversationId) {
        const conversation = getOrCreateSetupConversation(conversationId);
        conversation.draft.targetUrl = url.trim();
        return applyProbeToConversation(conversation, probe);
      }
      return probe;
    },
  );

  app.get<{ Querystring: { conversationId?: string } }>('/api/chat/setup', async (req) => {
    let conversation;
    if (req.query.conversationId) {
      try {
        conversation = getOrCreateSetupConversation(req.query.conversationId);
      } catch {
        conversation = getOrCreateSetupConversation();
      }
    } else {
      conversation = getOrCreateSetupConversation();
    }

    return {
      conversationId: conversation.id,
      messages: conversation.messages,
      draft: conversation.draft,
      readyToStart: false,
      missing: conversation.draft.targetUrl ? [] : ['target URL'],
    };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/chat', async (req, reply) => {
    const session = orchestrator.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    let history = liveChatStore.getHistory(req.params.id);
    if (history.length === 0) {
      history = liveChatStore.initSession(req.params.id, session.config.targetUrl);
    }

    return { messages: history, sessionStatus: session.status };
  });

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    '/api/sessions/:id/chat',
    async (req, reply) => {
      const session = orchestrator.getSession(req.params.id);
      if (!session) return reply.status(404).send({ error: 'Session not found' });

      const { message } = req.body;
      if (!message?.trim()) {
        return reply.status(400).send({ error: 'message is required' });
      }

      const result = processLiveMessage(session, message);
      const history = liveChatStore.append(req.params.id, ...result.messages);

      if (result.action === 'pause') {
        orchestrator.pauseSession(req.params.id);
      }

      if (result.action === 'update_auth' && result.credentials) {
        orchestrator.updateCredentials(req.params.id, result.credentials, result.authState);
      }

      if (result.action === 'resume' && result.credentials) {
        orchestrator.updateCredentials(req.params.id, result.credentials, result.authState ?? 'ready');
        await orchestrator.resumeSession(req.params.id);
      }

      return { messages: history, action: result.action };
    },
  );

  app.post<{ Params: { id: string }; Body: SessionCredentials }>(
    '/api/sessions/:id/credentials',
    async (req, reply) => {
      const session = orchestrator.getSession(req.params.id);
      if (!session) return reply.status(404).send({ error: 'Session not found' });

      orchestrator.updateCredentials(req.params.id, req.body);
      const updated = await orchestrator.resumeSession(req.params.id);
      return updated;
    },
  );
}

export function bridgeSessionEventToChat(event: SessionEvent): SessionEvent | null {
  const chatMsg = sessionEventToChatMessage(event);
  if (!chatMsg) return null;

  liveChatStore.append(event.sessionId, chatMsg);

  return {
    type: 'chat:message',
    sessionId: event.sessionId,
    timestamp: chatMsg.timestamp,
    payload: chatMsg,
  };
}

/** PRD upload during setup chat + session report download */
export function registerPrdAndReportRoutes(app: FastifyInstance, sessionsDir: string): void {
  app.post<{ Querystring: { conversationId?: string } }>(
    '/api/chat/setup/upload-prd',
    async (req, reply) => {
      const conversationId = req.query.conversationId;
      if (!conversationId) {
        return reply.status(400).send({ error: 'conversationId query param is required' });
      }

      try {
        getOrCreateSetupConversation(conversationId);
      } catch (err) {
        return reply.status(404).send({ error: (err as Error).message });
      }

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

      const setupDir = join(sessionsDir, `setup-${conversationId}`);
      await mkdir(setupDir, { recursive: true });
      const prdPath = join(setupDir, `prd.${ext}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(prdPath, buffer);

      return attachPrdToSetupConversation(conversationId, prdPath, filename);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/sessions/:id/report',
    async (req, reply) => {
      const session = await orchestrator.getSessionOrRehydrate(req.params.id, sessionsDir);
      if (!session) return reply.status(404).send({ error: 'Session not found' });

      const format = (req.query.format ?? 'json').toLowerCase();

      let report = generateSessionReport(session);
      if (session.status === 'completed' || session.status === 'failed') {
        try {
          report = await writeSessionReport(sessionsDir, session);
        } catch {
          /* keep in-memory report */
        }
      }

      if (format === 'md' || format === 'markdown') {
        // Prefer rich template report; fall back to PRD-aware markdown if needed
        const md = report.markdown || generateSessionReportMarkdown(session);
        return reply
          .header('Content-Type', 'text/markdown; charset=utf-8')
          .header(
            'Content-Disposition',
            `attachment; filename="qa-report-${session.id.slice(0, 8)}.md"`,
          )
          .send(md);
      }

      if (format === 'html') {
        return reply
          .header('Content-Type', 'text/html; charset=utf-8')
          .header(
            'Content-Disposition',
            `inline; filename="qa-report-${session.id.slice(0, 8)}.html"`,
          )
          .send(report.html);
      }

      return {
        sessionId: session.id,
        status: session.status,
        ...report.summary,
        markdown: report.markdown,
        html: report.html,
        findings: report.summary.findings,
        prdCoverage: session.prdCoverage ?? null,
        reportMarkdown: generateSessionReportMarkdown(session),
        session,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { question: string } }>(
    '/api/sessions/:id/ask',
    async (req, reply) => {
      const session = await orchestrator.getSessionOrRehydrate(req.params.id, sessionsDir);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      const question = req.body?.question?.trim();
      if (!question) return reply.status(400).send({ error: 'question is required' });

      const answer = answerFindingsQuestion(question, {
        findings: session.findings,
        targetUrl: session.config.targetUrl,
        prdCoverage: session.prdCoverage,
      });
      return { answer };
    },
  );
}
