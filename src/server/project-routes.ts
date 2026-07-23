import type { FastifyInstance } from "fastify";
import * as projects from "../remote/projects.js";
import * as chats from "../remote/chats.js";
import { RemoteSessionManager } from "../remote/session-manager.js";
import { listConversations, buildResumeSummary } from "../memory/conversations.js";
import type { Runtime } from "../runtime.js";

function publicUrl(): string {
  // `||` not `??` -- see admin-routes.ts's buildSetupInstructions for why.
  return process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.PORT ?? 8787}`;
}

function resumePrompt(summary: string): string {
  return `Resuming a previous conversation. Here's a summary of where it left off:\n\n${summary}\n\nPlease continue from here.`;
}

function connectUrl(token: string, initialMessage?: string): string {
  const url = `${publicUrl()}/remote?token=${token}`;
  return initialMessage ? `${url}&initialMessage=${encodeURIComponent(initialMessage)}` : url;
}

export function registerProjectRoutes(app: FastifyInstance, runtime: Runtime, manager: RemoteSessionManager): void {
  app.get("/admin/api/projects", async () => {
    return { projects: await projects.listProjects() };
  });

  app.post("/admin/api/projects", async (req, reply) => {
    const { name, dirName } = (req.body ?? {}) as { name?: string; dirName?: string };
    if (!name || !name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }
    try {
      return { project: await projects.createProject(name.trim(), dirName) };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.patch("/admin/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || !name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }
    const project = await projects.renameProject(id, name.trim());
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { project };
  });

  app.delete("/admin/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Stop any live chats first -- deleting the tracking entry shouldn't
    // leave an orphaned PTY nothing can reach or stop anymore.
    for (const chat of await chats.listChats(id)) {
      manager.stop(chat.id);
      await chats.deleteChat(chat.id);
    }
    const ok = await projects.deleteProject(id);
    if (!ok) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { ok: true };
  });

  app.get("/admin/api/projects/:id/chats", async (req) => {
    const { id } = req.params as { id: string };
    const records = await chats.listChats(id);
    return {
      chats: records.map((chat) => {
        const live = manager.get(chat.id);
        return {
          ...chat,
          active: !!live,
          connectedClients: live?.clients.size ?? 0,
          connectUrl: live ? connectUrl(live.token) : null,
        };
      }),
    };
  });

  app.post("/admin/api/projects/:id/chats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, resumeConversationId } = (req.body ?? {}) as { title?: string; resumeConversationId?: string };
    const project = await projects.getProject(id);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }

    // No process to prime with this as an initial CLI argument anymore --
    // a chat isn't backed by a persistent process at all now, just a
    // connectable slot. Returned to the client instead, to send as the
    // first user_message once it connects.
    let initialMessage: string | undefined;
    if (resumeConversationId) {
      const summary = await buildResumeSummary(runtime.router, resumeConversationId);
      if (!summary) {
        reply.code(404);
        return { error: "that conversation wasn't found (it may be too old -- only the last ~2 weeks are scanned)" };
      }
      initialMessage = resumePrompt(summary);
    }

    const chat = await chats.createChat(id, title?.trim() || "New chat");
    try {
      const session = manager.start(chat.id, project.workspaceDir);
      return { chat, token: session.token, connectUrl: connectUrl(session.token, initialMessage), initialMessage };
    } catch (err) {
      await chats.deleteChat(chat.id);
      reply.code(409);
      return { error: (err as Error).message };
    }
  });

  app.patch("/admin/api/chats/:chatId", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const { title } = (req.body ?? {}) as { title?: string };
    if (!title || !title.trim()) {
      reply.code(400);
      return { error: "title is required" };
    }
    const chat = await chats.renameChat(chatId, title.trim());
    if (!chat) {
      reply.code(404);
      return { error: "chat not found" };
    }
    return { chat };
  });

  app.post("/admin/api/chats/:chatId/stop", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const stopped = manager.stop(chatId);
    await chats.markChatEnded(chatId);
    if (!stopped) {
      reply.code(404);
      return { error: "no live session for that chat" };
    }
    return { ok: true };
  });

  // Re-opens an existing chat's connectable slot. If Claude Code captured
  // a session id from an earlier turn (chat.claudeSessionId), it's passed
  // through so the next message genuinely resumes that conversation via
  // `--resume` -- unlike the old PTY model, this is a real continuation,
  // not just "same folder, fresh context."
  app.post("/admin/api/chats/:chatId/reopen", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const chat = await chats.getChat(chatId);
    if (!chat) {
      reply.code(404);
      return { error: "chat not found" };
    }
    const project = await projects.getProject(chat.projectId);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }
    try {
      const session = manager.start(chat.id, project.workspaceDir, chat.claudeSessionId);
      await chats.markChatStarted(chat.id);
      return { token: session.token, connectUrl: connectUrl(session.token) };
    } catch (err) {
      reply.code(409);
      return { error: (err as Error).message };
    }
  });

  app.delete("/admin/api/chats/:chatId", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    manager.stop(chatId);
    const ok = await chats.deleteChat(chatId);
    if (!ok) {
      reply.code(404);
      return { error: "chat not found" };
    }
    return { ok: true };
  });

  app.get("/admin/api/remote/conversations", async () => {
    return { conversations: await listConversations() };
  });
}
