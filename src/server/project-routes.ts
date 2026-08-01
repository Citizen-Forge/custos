import type { FastifyInstance } from "fastify";
import * as projects from "../remote/projects.js";
import * as chats from "../remote/chats.js";
import { RemoteSessionManager } from "../remote/session-manager.js";
import { readTranscript } from "../remote/transcript.js";
import { getSettings, deleteSettings, updateSettings } from "../pm/project-settings.js";
import { STEERING_PROMPT, PORTFOLIO_PROMPT } from "../pm/prompts.js";
import { buildPortfolioMcpConfig } from "../mcp/server.js";
import { deleteProjectAgents } from "../pm/agents.js";
import { deleteProjectWorkItems } from "../pm/board.js";
import { deleteProjectIdeas } from "../pm/ideas.js";
import { deleteProjectRuns } from "../pm/runs.js";
import { releaseProjectWorkspaces } from "../pm/worktrees.js";
import { deleteProjectSecrets } from "../pm/vault.js";
import { deleteProjectFacts } from "../pm/facts.js";
import { createProjectWithSetup } from "../pm/project-creation.js";
import type { Runtime } from "../runtime.js";

function publicUrl(): string {
  // `||` not `??` -- see admin-routes.ts's buildSetupInstructions for why.
  return process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.PORT ?? 8787}`;
}

function connectUrl(token: string, initialMessage?: string): string {
  const url = `${publicUrl()}/remote?token=${token}`;
  return initialMessage ? `${url}&initialMessage=${encodeURIComponent(initialMessage)}` : url;
}

/** Steering chats are the same machinery as an ordinary chat, pointed at a
 * different persona and (usually) a stronger model. Resolved here rather
 * than stored on the chat so that changing a project's steering model in
 * settings takes effect on the next reopen instead of only on new chats. */
async function sessionOptionsFor(chat: chats.ChatRecord): Promise<{ appendSystemPrompt?: string; model?: string; mcpConfig?: string; kind: chats.ChatKind }> {
  const kind = chat.kind ?? "chat";
  if (kind === "portfolio") return { kind, appendSystemPrompt: PORTFOLIO_PROMPT, mcpConfig: buildPortfolioMcpConfig() };
  if (kind !== "steering") return { kind };
  const settings = await getSettings(chat.projectId as string);
  return { kind, appendSystemPrompt: STEERING_PROMPT, model: settings.steeringModel };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  manager: RemoteSessionManager,
  /** Kicks off the codebase survey for a newly-cloned project. Injected
   * rather than importing the orchestrator, which already depends on this
   * module's project store. */
  onSurveyRequested?: (projectId: string) => void,
): void {
  app.get("/admin/api/projects", async () => {
    return { projects: await projects.listProjects() };
  });

  /**
   * Creates a project, optionally around an existing repository.
   *
   * Bringing an existing codebase in is the common case and used to be the
   * badly-served one: you got an empty folder and every agent started blind,
   * rediscovering how to build and test the thing on its own first ticket.
   * Cloning here, recording what we know, and kicking off a survey pass is
   * what turns "a folder" into "a project the agents understand".
   */
  app.post("/admin/api/projects", async (req, reply) => {
    const { name, dirName, repoUrl, description } = (req.body ?? {}) as {
      name?: string;
      dirName?: string;
      repoUrl?: string;
      description?: string;
    };
    if (!name || !name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }

    try {
      return await createProjectWithSetup({ name, dirName, repoUrl, description }, onSurveyRequested);
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
    // leave an orphaned turn mid-run or connected WebSocket clients with
    // nothing to disconnect them.
    for (const chat of await chats.listChats(id)) {
      manager.stop(chat.id);
      await chats.deleteChat(chat.id);
    }
    // The workspace directory survives (see projects.deleteProject), but the
    // PM records are Custos's own bookkeeping about a project that no longer
    // exists, so they go with it rather than accumulating as orphans. The
    // per-ticket worktrees go too -- they're Custos-created scratch
    // checkouts, and the branches they hold stay in the repository.
    const project = await projects.getProject(id);
    if (project) await releaseProjectWorkspaces(project.workspaceDir, id).catch(() => undefined);
    await Promise.all([
      deleteProjectWorkItems(id),
      deleteProjectIdeas(id),
      deleteProjectAgents(id),
      deleteProjectRuns(id),
      deleteSettings(id),
      deleteProjectSecrets(id),
      deleteProjectFacts(id),
    ]);
    const ok = await projects.deleteProject(id);
    if (!ok) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { ok: true };
  });

  app.get("/admin/api/projects/:id/chats", async (req) => {
    const { id } = req.params as { id: string };
    const { kind } = req.query as { kind?: chats.ChatKind };
    const records = await chats.listChats(id, kind);
    return {
      chats: records.map((chat) => {
        const live = manager.get(chat.id);
        return {
          ...chat,
          // Chats created before steering existed have no `kind` on disk.
          kind: chat.kind ?? "chat",
          active: !!live,
          connectedClients: live?.clients.size ?? 0,
          connectUrl: live ? connectUrl(live.token) : null,
        };
      }),
    };
  });

  app.post("/admin/api/projects/:id/chats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, kind } = (req.body ?? {}) as { title?: string; kind?: chats.ChatKind };
    const project = await projects.getProject(id);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }

    const chat = await chats.createChat(id, title?.trim() || (kind === "steering" ? "New discussion" : "New chat"), kind ?? "chat");
    try {
      const session = manager.start(chat.id, id, project.workspaceDir, await sessionOptionsFor(chat));
      return { chat, token: session.token, connectUrl: connectUrl(session.token) };
    } catch (err) {
      await chats.deleteChat(chat.id);
      reply.code(409);
      return { error: (err as Error).message };
    }
  });

  // Portfolio chats aren't scoped to a project, so they get their own
  // top-level create/list pair instead of living under
  // /admin/api/projects/:id/chats -- everything else (rename, stop,
  // reopen, delete, transcript) is already project-agnostic (looked up by
  // chatId alone) and needs no portfolio-specific route.

  app.get("/admin/api/portfolio-chats", async () => {
    const records = await chats.listChats(undefined, "portfolio");
    return {
      chats: records.map((chat) => {
        const live = manager.get(chat.id);
        return { ...chat, active: !!live, connectedClients: live?.clients.size ?? 0, connectUrl: live ? connectUrl(live.token) : null };
      }),
    };
  });

  app.post("/admin/api/portfolio-chats", async (req, reply) => {
    const { title } = (req.body ?? {}) as { title?: string };
    const chat = await chats.createChat(null, title?.trim() || "New portfolio chat", "portfolio");
    try {
      const workspaceDir = await projects.portfolioWorkspaceDir();
      const session = manager.start(chat.id, null, workspaceDir, await sessionOptionsFor(chat));
      return { chat, token: session.token, connectUrl: connectUrl(session.token) };
    } catch (err) {
      await chats.deleteChat(chat.id);
      reply.code(409);
      return { error: (err as Error).message };
    }
  });

  /** A chat's past turns, replayed from Claude Code's own transcript so
   * reopening one shows the conversation instead of an empty pane. Empty
   * for a chat that never completed a turn. */
  app.get("/admin/api/chats/:chatId/transcript", async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const chat = await chats.getChat(chatId);
    if (!chat) {
      reply.code(404);
      return { error: "chat not found" };
    }
    if (!chat.claudeSessionId) return { entries: [] };
    return { entries: await readTranscript(chat.claudeSessionId) };
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
    let workspaceDir: string;
    if (chat.projectId === null) {
      workspaceDir = await projects.portfolioWorkspaceDir();
    } else {
      const project = await projects.getProject(chat.projectId);
      if (!project) {
        reply.code(404);
        return { error: "project not found" };
      }
      workspaceDir = project.workspaceDir;
    }
    try {
      const session = manager.start(chat.id, chat.projectId, workspaceDir, {
        ...(await sessionOptionsFor(chat)),
        claudeSessionId: chat.claudeSessionId,
      });
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
}
