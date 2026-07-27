import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { Orchestrator } from "../pm/orchestrator.js";
import * as board from "../pm/board.js";
import * as ideas from "../pm/ideas.js";
import * as agentStore from "../pm/agents.js";
import * as runs from "../pm/runs.js";
import { getSettings, updateSettings } from "../pm/project-settings.js";
import { getProject } from "../remote/projects.js";
import { releaseWorkspace } from "../pm/worktrees.js";
import * as vault from "../pm/vault.js";
import * as facts from "../pm/facts.js";
import * as registry from "../pm/model-registry.js";
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
    await agentStore.ensureProjectAgents(id);
    return {
      settings: await getSettings(id),
      agents: await agentStore.listAgents(id),
      spentUsd: await runs.monthlySpendUsd(id),
      subscriptionUsd: await runs.monthlyUnbilledUsd(id),
    };
  });

  app.patch("/admin/api/projects/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Partial<Omit<ProjectSettings, "id">>;
    return { settings: await updateSettings(id, patch) };
  });

  // ---------------------------------------------------------------- vault
  //
  // Deliberately write-only: there is no endpoint that returns a stored
  // value, for any caller, ever. A secret goes in once and after that only
  // its name, description and last four characters are readable. If you've
  // lost the value, replace it -- that's the intended path, not a gap.

  app.get("/admin/api/projects/:id/secrets", async (req) => {
    const { id } = req.params as { id: string };
    return { secrets: await vault.listSecrets(id) };
  });

  app.get("/admin/api/secrets", async () => {
    return { secrets: await vault.listSecrets() };
  });

  app.post("/admin/api/secrets", async (req, reply) => {
    const body = (req.body ?? {}) as vault.CreateSecretInput;
    try {
      return { secret: await vault.createSecret(body) };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.patch("/admin/api/secrets/:secretId", async (req, reply) => {
    const { secretId } = req.params as { secretId: string };
    const secret = await vault.updateSecret(secretId, (req.body ?? {}) as vault.UpdateSecretInput);
    if (!secret) return notFound(reply, "secret");
    return { secret };
  });

  app.delete("/admin/api/secrets/:secretId", async (req, reply) => {
    const { secretId } = req.params as { secretId: string };
    if (!(await vault.deleteSecret(secretId))) return notFound(reply, "secret");
    return { ok: true };
  });

  app.get("/admin/api/projects/:id/activity", async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    const stalled = await runs.listStalledRuns(id);
    return {
      runs: await runs.listRuns(id, Number(limit) || 50),
      active: await runs.listActiveRuns(id),
      stalledRunIds: stalled.map((run) => run.id),
      busy: orchestrator.activeKeys(),
    };
  });

  // ------------------------------------------------------------ killswitch

  /** Stops this project dead: aborts every running agent and blocks further
   * dispatch until resumed. Persisted, so it survives a restart. */
  app.post("/admin/api/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    const aborted = await orchestrator.pauseProject(id);
    return { ok: true, aborted };
  });

  app.post("/admin/api/projects/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await orchestrator.resumeProject(id);
    return { ok: true };
  });

  /** Resets pmConfigured so the Project Manager re-evaluates model
   * assignments on the next tick. Useful after editing providers or
   * changing the budget cap. Returns immediately; the PM runs in the
   * background. */
  app.post("/admin/api/projects/:id/reassign-models", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await updateSettings(id, { pmConfigured: false });
    void orchestrator.assignModels(id);
    return { ok: true };
  });

  // ----------------------------------------------------------- model registry

  app.get("/admin/api/models", async () => {
    const anthropicModels = agentStore
      .listProviderOptions(runtime.config)
      .filter((option) => option.providerKey === "anthropic")
      .map((option) => option.model);
    return { models: await registry.syncFromConfig(runtime.config, anthropicModels) };
  });

  /** Manual override for a capability rating -- the feedback loop is the
   * primary mechanism, but a human who knows a model is unsuited to this
   * codebase shouldn't have to wait for QA to discover it the expensive way. */
  app.patch("/admin/api/models/:providerKey/:model", async (req, reply) => {
    const { providerKey, model } = req.params as { providerKey: string; model: string };
    const { capability } = (req.body ?? {}) as { capability?: number };
    if (typeof capability !== "number" || capability < 1 || capability > 5) {
      reply.code(400);
      return { error: "capability must be a number between 1 and 5" };
    }
    const updated = await registry.setCapability(providerKey, decodeURIComponent(model), capability);
    if (!updated) return notFound(reply, "model");
    return { model: updated };
  });

  // ------------------------------------------------------- project knowledge

  app.get("/admin/api/projects/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return { facts: await facts.listFacts(id) };
  });

  app.post("/admin/api/projects/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key, value, category } = (req.body ?? {}) as { key?: string; value?: string; category?: facts.FactCategory };
    if (!key?.trim() || !value?.trim()) {
      reply.code(400);
      return { error: "key and value are required" };
    }
    return { fact: await facts.writeFact({ projectId: id, key: key.trim(), value: value.trim(), category }) };
  });

  app.delete("/admin/api/facts/:factId", async (req, reply) => {
    const { factId } = req.params as { factId: string };
    if (!(await facts.deleteFact(factId))) return notFound(reply, "fact");
    return { ok: true };
  });
}
