import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../pm/orchestrator.js";
import * as board from "../../pm/board.js";
import * as ideas from "../../pm/ideas.js";
import { notFound } from "./shared.js";

export function registerRoadmapRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
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
}
