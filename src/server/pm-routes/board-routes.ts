import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../pm/orchestrator.js";
import * as board from "../../pm/board.js";
import * as agentStore from "../../pm/agents.js";
import { getProject } from "../../remote/projects.js";
import { releaseWorkspace } from "../../pm/worktrees.js";
import { BOARD_STATUSES, type WorkItemType } from "../../pm/types.js";
import type { BoardStatus } from "../../pm/types.js";
import { isStatus, notFound } from "./shared.js";

export function registerBoardRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
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
    const item = await board.getWorkItem(itemId);
    if (!item) return notFound(reply, "work item");
    // Release the checkout before forgetting the ticket, or its worktree is
    // orphaned on disk with nothing left pointing at it.
    if (item.worktreePath) {
      const project = await getProject(item.projectId);
      if (project) await releaseWorkspace(project.workspaceDir, project.id, itemId).catch(() => undefined);
    }
    await board.deleteWorkItem(itemId);
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
      case "provision":
        void orchestrator.provisionRepo(id);
        return { ok: true };
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
}
