import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { Orchestrator } from "../pm/orchestrator.js";
import * as board from "../pm/board.js";
import * as ideas from "../pm/ideas.js";
import * as agentStore from "../pm/agents.js";
import * as runs from "../pm/runs.js";
import { getSettings, updateSettings } from "../pm/project-settings.js";
import { getProject } from "../remote/projects.js";
import { BOARD_STATUSES, type BoardStatus, type ProjectSettings, type WorkItemType } from "../pm/types.js";

const isStatus = (value: unknown): value is BoardStatus => BOARD_STATUSES.includes(value as BoardStatus);

/**
 * The project-management surface behind the four project tabs. All of it
 * sits under /admin/api and is gated by the same session login as the rest
 * of the admin API -- these endpoints move real work and spend real money,
 * so they're deliberately not on the client-API-key surface that Claude
 * Code itself authenticates against.
 */
export function registerPmRoutes(app: FastifyInstance, runtime: Runtime, orchestrator: Orchestrator): void {
  const notFound = (reply: { code: (n: number) => void }, what: string) => {
    reply.code(404);
    return { error: `${what} not found` };
  };

  // ------------------------------------------------------------- roadmap

  app.get("/admin/api/projects/:id/roadmap", async (req) => {
    const { id } = req.params as { id: string };
    return {
      inbox: (await ideas.listIdeas(id)).filter((idea) => idea.status !== "planned" && idea.status !== "rejected"),
      planned: (await ideas.listIdeas(id)).filter((idea) => idea.status === "planned"),
      epics: await board.listEpics(id),
      busy: orchestrator.activeKeys(),
    };
  });

  app.post("/admin/api/projects/:id/ideas", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, brief, sourceChatId } = (req.body ?? {}) as { title?: string; brief?: string; sourceChatId?: string };
    if (!title?.trim() || !brief?.trim()) {
      reply.code(400);
      return { error: "title and brief are required" };
    }
    const idea = await ideas.createIdea(id, title.trim(), brief.trim(), sourceChatId ?? null);
    return { idea };
  });

  /** Kicks the product owner at one inbox idea now rather than waiting for
   * the next tick -- the "plan this" button. Returns immediately; progress
   * shows up in the activity feed. */
  app.post("/admin/api/ideas/:ideaId/plan", async (req, reply) => {
    const { ideaId } = req.params as { ideaId: string };
    const idea = await ideas.getIdea(ideaId);
    if (!idea) return notFound(reply, "idea");
    void orchestrator.planIdea(idea.projectId, ideaId);
    return { ok: true };
  });

  app.delete("/admin/api/ideas/:ideaId", async (req, reply) => {
    const { ideaId } = req.params as { ideaId: string };
    if (!(await ideas.deleteIdea(ideaId))) return notFound(reply, "idea");
    return { ok: true };
  });

  // --------------------------------------------------------------- board

  app.get("/admin/api/projects/:id/board", async (req) => {
    const { id } = req.params as { id: string };
    return {
      columns: await board.listBoard(id),
      epics: (await board.listWorkItems(id)).filter((item) => item.type === "epic"),
      agents: await agentStore.listAgents(id),
      busy: orchestrator.activeKeys(),
    };
  });

  app.post("/admin/api/projects/:id/work-items", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { type?: WorkItemType; title?: string; description?: string; acceptanceCriteria?: string[]; parentId?: string | null; status?: BoardStatus };
    if (!body.title?.trim()) {
      reply.code(400);
      return { error: "title is required" };
    }
    const item = await board.createWorkItem({
      projectId: id,
      type: body.type ?? "story",
      title: body.title.trim(),
      description: body.description ?? "",
      acceptanceCriteria: body.acceptanceCriteria ?? [],
      parentId: body.parentId ?? null,
      status: isStatus(body.status) ? body.status : "backlog",
      actor: "human",
    });
    return { item };
  });

  app.get("/admin/api/work-items/:itemId", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const item = await board.getWorkItem(itemId);
    if (!item) return notFound(reply, "work item");
    const children = (await board.listWorkItems(item.projectId)).filter((row) => row.parentId === item.id);
    return { item, children, agents: await agentStore.listAgents(item.projectId) };
  });

  app.patch("/admin/api/work-items/:itemId", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const item = await board.updateWorkItem(itemId, (req.body ?? {}) as board.WorkItemPatch);
    if (!item) return notFound(reply, "work item");
    return { item };
  });

  /** Human drag-and-drop between columns. Deliberately unrestricted: the
   * role transition table constrains agents, not the person who owns the
   * board. */
  app.post("/admin/api/work-items/:itemId/status", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { status, note } = (req.body ?? {}) as { status?: string; note?: string };
    if (!isStatus(status)) {
      reply.code(400);
      return { error: `status must be one of: ${BOARD_STATUSES.join(", ")}` };
    }
    const item = await board.transitionWorkItem(itemId, status, "human", note);
    if (!item) return notFound(reply, "work item");
    return { item };
  });

  app.post("/admin/api/work-items/:itemId/comments", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const { body } = (req.body ?? {}) as { body?: string };
    if (!body?.trim()) {
      reply.code(400);
      return { error: "body is required" };
    }
    const comment = await board.addComment(itemId, "human", "You", body.trim());
    if (!comment) return notFound(reply, "work item");
    return { comment };
  });

  app.post("/admin/api/work-items/:itemId/subtasks/:subtaskId", async (req, reply) => {
    const { itemId, subtaskId } = req.params as { itemId: string; subtaskId: string };
    const { done } = (req.body ?? {}) as { done?: boolean };
    const item = await board.setSubtaskDone(itemId, subtaskId, !!done);
    if (!item) return notFound(reply, "work item");
    return { item };
  });

  app.delete("/admin/api/work-items/:itemId", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    if (!(await board.deleteWorkItem(itemId))) return notFound(reply, "work item");
    return { ok: true };
  });

  /** Manual "run this stage now" triggers, so the board is usable with
   * every autonomy toggle off -- a human can drive each agent one step at
   * a time and watch what it does before handing it the keys. */
  app.post("/admin/api/projects/:id/run/:stage", async (req, reply) => {
    const { id, stage } = req.params as { id: string; stage: string };
    const { workItemId } = (req.body ?? {}) as { workItemId?: string };
    if (!(await getProject(id))) return notFound(reply, "project");

    switch (stage) {
      case "groom":
        void orchestrator.groomBacklog(id);
        return { ok: true };
      case "assign":
        void orchestrator.assignReady(id);
        return { ok: true };
      case "engineer":
      case "qa":
      case "devops": {
        if (!workItemId) {
          reply.code(400);
          return { error: "workItemId is required for this stage" };
        }
        const run = { engineer: orchestrator.runEngineer, qa: orchestrator.runQa, devops: orchestrator.runDevops }[stage];
        void run.call(orchestrator, id, workItemId);
        return { ok: true };
      }
      default:
        reply.code(400);
        return { error: `unknown stage "${stage}"` };
    }
  });

  // -------------------------------------------------------------- agents

  app.get("/admin/api/projects/:id/agents", async (req) => {
    const { id } = req.params as { id: string };
    await agentStore.ensureProjectAgents(id);
    return { agents: await agentStore.listAgents(id), providerOptions: agentStore.listProviderOptions(runtime.config) };
  });

  app.patch("/admin/api/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const agent = await agentStore.updateAgent(agentId, (req.body ?? {}) as agentStore.AgentPatch);
    if (!agent) return notFound(reply, "agent");
    return { agent };
  });

  app.delete("/admin/api/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    if (!(await agentStore.deleteAgent(agentId))) return notFound(reply, "agent");
    return { ok: true };
  });

  // ---------------------------------------------------- settings & devops

  app.get("/admin/api/projects/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    return { settings: await getSettings(id), spentUsd: await runs.monthlySpendUsd(id) };
  });

  app.patch("/admin/api/projects/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Partial<Omit<ProjectSettings, "id">>;
    return { settings: await updateSettings(id, patch) };
  });

  app.get("/admin/api/projects/:id/activity", async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    return {
      runs: await runs.listRuns(id, Number(limit) || 50),
      active: await runs.listActiveRuns(id),
      busy: orchestrator.activeKeys(),
    };
  });
}
