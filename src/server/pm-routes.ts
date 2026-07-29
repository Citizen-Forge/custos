import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { Orchestrator } from "../pm/orchestrator.js";
import { listProjects as listAllProjects } from "../remote/projects.js";
import * as board from "../pm/board.js";
import * as ideas from "../pm/ideas.js";
import * as agentStore from "../pm/agents.js";
import * as runs from "../pm/runs.js";
import { buildNowWorking, resolveWorkItemTitles, type NowWorkingSummary } from "../pm/now-working.js";
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
    // Fallback sets ride along on the agents response so the agent-card
    // dropdown can list them without a second round-trip. The shape is
    // trimmed to the fields the UI actually renders (name, description,
    // first provider chain) — the full sets live in /admin/api/fallback-sets
    // for the Settings panel.
    return {
      agents: await agentStore.listAgents(id),
      providerOptions: agentStore.listProviderOptions(runtime.config),
      fallbackSets: runtime.config.fallbackSets ?? {},
    };
  });

  app.patch("/admin/api/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = (req.body ?? {}) as agentStore.AgentPatch;
    // If the caller assigned a fallbackSet, validate it still exists in
    // config — otherwise the runtime would dispatch to a non-existent set
    // and 503 on every request. Accepting the unknown name silently would
    // be a footgun (the UI dropdown always shows valid sets, but a hand-
    // edited request could still reach here).
    if (body.fallbackSet && !runtime.config.fallbackSets?.[body.fallbackSet]) {
      reply.code(400);
      return { error: `fallback set "${body.fallbackSet}" is not configured` };
    }
    const agent = await agentStore.updateAgent(agentId, body);
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
    const pastRuns = await runs.listRuns(id, Number(limit) || 50);
    const active = await runs.listActiveRuns(id);
    const stalled = await runs.listStalledRuns(id);
    const stalledRunIds = stalled.map((run) => run.id);

    // Resolve work-item titles once for every work item referenced by
    // any run in the response (active + past). Hand-off to the shared
    // helper which keeps the per-agent lookup O(1) via pre-built maps.
    const itemTitles = await resolveWorkItemTitles(
      [...active, ...pastRuns].map((r) => r.workItemId),
      (wid) => board.getWorkItem(wid),
    );

    const nowWorking = buildNowWorking(
      await agentStore.listAgents(id),
      active,
      pastRuns,
      stalledRunIds,
      itemTitles,
    );
    // Same per-agent on-disk shape the existing UI consumes (a map
    // keyed by agentId) -- the consumer doesn't have to learn the
    // cross-project array shape.
    const nowWorkingByAgent: Record<string, NowWorkingSummary> = Object.fromEntries(
      nowWorking.map((row) => [row.agentId, row.summary]),
    );

    return {
      runs: pastRuns,
      active,
      stalledRunIds,
      busy: orchestrator.activeKeys(),
      nowWorkingByAgent,
    };
  });

  /** Fleet-wide "all agents, all projects" -- aggregates the per-project
   *  activity response into a single payload so the admin UI can render
   *  one consolidated roster view without N round-trips. Internally
   *  fans out to the same shared enrichment helper as the per-project
   *  endpoint, so a bug fix to the work-item-title resolution or the
   *  status picking drops into both surfaces at once.
   *
   *  Response shape is keyed by (projectId, agentId) tuples so agent
   *  IDs aren't ambiguous across projects (the per-project Map shape
   *  the existing UI uses won't survive project boundaries). */
  app.get("/admin/api/now-working", async () => {
    const projects = await listAllProjects();
    // Resolve work-item titles across ALL projects in a single batch --
    // avoids a per-project lookup waterfall when the fleet is idle and
    // resolves the moment a poll returns with no new activity.
    const allWorkItemIds: Array<string | null> = [];
    const perProjectRuns: Array<{
      project: typeof projects[number];
      agents: Awaited<ReturnType<typeof agentStore.listAgents>>;
      active: Awaited<ReturnType<typeof runs.listActiveRuns>>;
      past: Awaited<ReturnType<typeof runs.listRuns>>;
      stalledIds: string[];
    }> = [];
    for (const project of projects) {
      const [agents, active, past, stalled] = await Promise.all([
        agentStore.listAgents(project.id),
        runs.listActiveRuns(project.id),
        runs.listRuns(project.id, 50),
        runs.listStalledRuns(project.id),
      ]);
      perProjectRuns.push({
        project,
        agents,
        active,
        past,
        stalledIds: stalled.map((r) => r.id),
      });
      for (const r of [...active, ...past]) allWorkItemIds.push(r.workItemId);
    }
    const itemTitles = await resolveWorkItemTitles(allWorkItemIds, (wid) => board.getWorkItem(wid));

    const result = perProjectRuns.map((entry) => ({
      id: entry.project.id,
      name: entry.project.name,
      agents: buildNowWorking(
        entry.agents,
        entry.active,
        entry.past,
        entry.stalledIds,
        itemTitles,
      ),
    }));

    return {
      generatedAt: Date.now(),
      // orchestrator.activeKeys() returns the fleet-wide busy list, not
      // per-project -- hanging it under every project would duplicate
      // the same array N times. Top-level placement makes the wire
      // shape honest about what "busy" means.
      busy: orchestrator.activeKeys(),
      projects: result,
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

  /** Flips pmConfigured to false so the Project Manager re-evaluates
   * model assignments on its NEXT tick -- deferring to the existing
   * tick cadence instead of forcing a synchronous assignment pass.
   * Distinct from /reassign-models: that endpoint actively runs
   * assignModels() now (costs one PM call right away); this endpoint
   * leaves the choice to the orchestrator's normal 20s pass. Use after
   * editing providers, the project's budget, or the agent model menu
   * -- anywhere a config change should be picked up but the existing
   * PM work doesn't need to be re-done right this second. The orchestrator
   * gate at tickProject() reads !settings.pmConfigured and triggers
   * assignModels() on its own; no explicit call here. */
  app.post("/admin/api/projects/:id/reset-pm", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await updateSettings(id, { pmConfigured: false });
    // Operator-visible feedback in the activity feed: the reset is
    // immediate but the actual reassignment happens on the next tick,
    // so an explicit "reset requested" entry makes the gap visible.
    orchestrator.emit("activity", id, "Project Manager reset — will re-evaluate on next tick.");
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
