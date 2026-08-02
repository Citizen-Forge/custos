import { EventEmitter } from "node:events";
import type { Runtime } from "../runtime.js";
import { getProject, listProjects, type Project } from "../remote/projects.js";
import * as board from "./board.js";
import * as ideas from "./ideas.js";
import * as agentStore from "./agents.js";
import * as runs from "./runs.js";
import { getSettings, updateSettings } from "./project-settings.js";
import { listFacts, renderFacts, writeFact } from "./facts.js";
import { runAgent } from "./agent-runner.js";
import { ensureWorkspace, isGitRepo, releaseWorkspace, verifyGitHubAccess, verifyPullRequest } from "./worktrees.js";
import { renderAgentRoster, renderBoardSummary, renderIdea, renderModelMenu, renderProjectContext, renderSecrets, renderWorkItem } from "./context.js";
import { isAvailable, modelId, recordOutcome, syncFromConfig } from "./model-registry.js";
import { hasGitCredentials, listSecrets, resolveAgentEnv } from "./vault.js";
import { ASSIGN_MODELS_SHAPE, ASSIGN_SHAPE, DEVOPS_SHAPE, ENGINEER_SHAPE, GROOM_SHAPE, PLAN_SHAPE, PROVISION_SHAPE, QA_SHAPE, SURVEY_PROMPT, SURVEY_SHAPE, outputContract } from "./prompts.js";
import type { AssignContract, DevopsContract, EngineerContract, FactWrite, GroomContract, PlanContract, ProjectManagerContract, ProvisionContract, QaContract } from "./contracts.js";
import type { AgentDef, AgentRole, DeployTarget, ProjectSettings, WorkItem } from "./types.js";
import { HUMAN_ASSIGNEE_ID } from "./types.js";

const TICK_MS = Number(process.env.CUSTOS_ORCHESTRATOR_TICK_MS ?? 20_000);

/** Hard ceiling on concurrent engineers regardless of project settings --
 * every one is a live `claude` process with its own checkout, and a
 * mistyped setting shouldn't be able to fork-bomb the container. */
const ABSOLUTE_MAX_ENGINEERS = 12;

/** Applied to work that reaches "complete" and hasn't been deployed yet.
 * A label rather than a status so the board's five columns stay the ones
 * the user asked for. */
const DEPLOYED_LABEL = "deployed";

export interface OrchestratorEvents {
  change: [projectId: string];
  activity: [projectId: string, message: string];
}

/**
 * The loop that turns board state into agent runs.
 *
 * It is deliberately a poll rather than an event cascade: every stage's
 * precondition is a query over the board ("is there a ready ticket with no
 * assignee"), so a tick that re-derives everything from persisted state is
 * correct after a restart, after a human drags a card between columns, and
 * after a run fails halfway -- none of which an in-memory event chain would
 * survive. Nothing here holds work in memory between ticks except the set
 * of runs currently in flight.
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Keys of the form "<stage>:<id>" for work currently in flight, so a
   * long engineer run isn't dispatched again by the next tick. Each maps to
   * the controller that can abort it, which is what makes the killswitch
   * immediate rather than "stops starting new things". */
  private readonly busy = new Map<string, AbortController>();

  constructor(private readonly runtime: Runtime) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  activeKeys(): string[] {
    return [...this.busy.keys()];
  }

  /** One pass over every project. Stage failures are contained per project
   * so one broken workspace can't stall the others. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const project of await listProjects()) {
        try {
          await this.tickProject(project);
        } catch {
          // Stage helpers already record their own failures against the run
          // and the ticket; swallow here so the loop keeps going.
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickProject(project: Project): Promise<void> {
    const settings = await getSettings(project.id);
    if (settings.paused) return;

    // Live runs move without the board changing, so nudge watchers each tick
    // while anything is running -- that's what keeps "what is it doing right
    // now" current in the UI without a second push channel.
    const active = await runs.listActiveRuns(project.id);
    if (active.length) this.emit("change", project.id);

    // A run's own lastEventAt only advances on TurnEvents from ITS OWN
    // `claude` process's stdout. A Task sub-agent it spawned reuses the
    // same ANTHROPIC_MODEL alias (same projectId/agentId/role), so its
    // dispatches land in the GlobalQueue's activity log under the SAME
    // agentId -- but the parent process emits nothing on its own stream
    // while waiting on that sub-agent, which looks identical to a
    // genuine stall from lastEventAt alone. Cross-referencing the
    // activity log here folds that real, otherwise-invisible progress
    // back into the run's own tracking before the stall check below
    // runs, so a ticket actually being worked by a sub-agent doesn't get
    // surfaced as "doing nothing."
    const activityLog = this.runtime.globalQueue?.queueActivityLog();
    if (activityLog) {
      for (const run of active) {
        const latest = activityLog.mostRecentEventForAgent(run.agentId);
        if (latest && latest.timestamp > run.lastEventAt) {
          await runs.recordActivity(run.id, `sub-agent activity: ${latest.outcome} on ${latest.provider ?? "?"}/${latest.model ?? "?"}`, false);
        }
      }
    }

    // Surface, don't kill. A long build legitimately looks like a stall, and
    // only the operator knows which is which -- the hard timeout in
    // agent-runner is what eventually stops a genuinely hung run.
    for (const stalled of await runs.listStalledRuns(project.id)) {
      const minutes = Math.round((Date.now() - stalled.lastEventAt) / 60_000);
      this.emit(
        "activity",
        project.id,
        `${stalled.role} has done nothing for ${minutes}m — last action: ${stalled.currentAction ?? "none recorded"}`,
      );
    }

    if (await this.overBudget(project.id, settings)) return;

    // Run the Project Manager on the first tick to assign provider/models
    // to the built-in roles based on budget and available providers. After
    // that, the engineering manager handles per-ticket model selection.
    if (!settings.pmConfigured && settings.autonomy["project-manager"]) {
      void this.assignModels(project.id);
      return;
    }

    if (settings.autonomy["product-owner"]) {
      const inbox = (await ideas.listIdeas(project.id)).filter((idea) => idea.status === "inbox");
      for (const idea of inbox) void this.planIdea(project.id, idea.id);
      const backlog = (await board.listWorkItems(project.id)).filter((item) => item.status === "backlog");
      if (backlog.length) void this.groomBacklog(project.id);
    }

    const readyWork = (await board.listWorkItems(project.id)).filter((item) => item.type !== "epic" && item.status === "ready");

    // Nothing can be built before there's somewhere to build it. Once there
    // is ready work and no repository, standing one up is the only sensible
    // next action -- so it runs ahead of assignment rather than letting the
    // engineering manager assign tickets nobody can start.
    if (settings.autonomy.devops && !settings.repoUrl && readyWork.length) {
      void this.provisionRepo(project.id);
      return;
    }

    // Only run the manager when it has somewhere to put the work. Without
    // this it re-ran on every tick while the engineers were busy, paying for
    // a full sizing pass each time to discover it had no free slots -- a few
    // cents every twenty seconds, indefinitely.
    if (settings.autonomy["engineering-manager"] && readyWork.length) {
      const limit = await this.engineerLimit(project, settings);
      const inFlight = (await board.listWorkItems(project.id)).filter((item) => item.status === "in_progress").length;
      if (inFlight < limit) void this.assignReady(project.id);
    }

    if (settings.autonomy.engineer) {
      const limit = await this.engineerLimit(project, settings);
      const inProgress = (await board.listWorkItems(project.id)).filter(
        // HUMAN_ASSIGNEE_ID tickets are excluded deliberately -- a human
        // claimed the work directly (MCP claim_ticket), there's no agent
        // to dispatch, and runEngineer's own agentStore.getAgent() lookup
        // would just fail silently every tick otherwise.
        (item) => item.status === "in_progress" && item.assigneeAgentId && item.assigneeAgentId !== HUMAN_ASSIGNEE_ID && !board.isBackingOff(item),
      );
      const live = this.countBusy("engineer:");
      const dispatchable = inProgress.filter((item) => !this.busy.has(`engineer:${item.id}`));
      for (const item of dispatchable.slice(0, Math.max(0, limit - live))) {
        void this.runEngineer(project.id, item.id);
      }
    }

    if (settings.autonomy.qa) {
      for (const item of (await board.listWorkItems(project.id)).filter((i) => i.status === "qa" && !board.isBackingOff(i))) {
        void this.runQa(project.id, item.id);
      }
    }

    if (settings.autonomy.devops && settings.deployTarget !== "none") {
      const deployable = (await board.listWorkItems(project.id)).filter(
        (item) => item.status === "complete" && !item.labels.includes(DEPLOYED_LABEL),
      );
      for (const item of deployable) void this.runDevops(project.id, item.id);
    }
  }

  private countBusy(prefix: string): number {
    let count = 0;
    for (const key of this.busy.keys()) if (key.startsWith(prefix)) count += 1;
    return count;
  }

  /**
   * How many engineers may run at once. Normally the project's own setting,
   * but a project that isn't a git repository has nothing to cut isolated
   * worktrees from, so its engineers would share one working copy and
   * overwrite each other -- those are clamped to one at a time.
   */
  private async engineerLimit(project: Project, settings: ProjectSettings): Promise<number> {
    const configured = Math.max(1, Math.min(settings.maxConcurrentEngineers ?? 1, ABSOLUTE_MAX_ENGINEERS));
    if (configured === 1) return 1;
    return (await isGitRepo(project.workspaceDir)) ? configured : 1;
  }

  private async overBudget(projectId: string, settings: ProjectSettings): Promise<boolean> {
    if (settings.budget.monthlyUsd === null) return false;
    const spent = await this.runtime.spendTracker.getProjectSpend(projectId);
    if (spent < settings.budget.monthlyUsd) return false;
    this.emit("activity", projectId, `Paused: this month's agent budget ($${settings.budget.monthlyUsd}) is spent.`);
    return true;
  }

  /** Wraps a stage so it can't be double-dispatched and always emits a
   * change when it finishes, whatever the outcome. */
  private async guard<T>(key: string, projectId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (this.busy.has(key)) return null;
    const controller = new AbortController();
    this.busy.set(key, controller);
    this.emit("change", projectId);
    try {
      return await fn(controller.signal);
    } finally {
      this.busy.delete(key);
      this.emit("change", projectId);
    }
  }

  /**
   * The killswitch. Aborts everything in flight for this project and, since
   * `paused` is persisted, stops the next tick dispatching anything new.
   * Aborting kills the underlying `claude` process rather than waiting for
   * it to finish, which is the point: this exists for "stop spending my
   * tokens right now", not "stop eventually".
   */
  async pauseProject(projectId: string): Promise<number> {
    await updateSettings(projectId, { paused: true });
    let aborted = 0;
    for (const [key, controller] of this.busy) {
      if (!key.endsWith(`:${projectId}`) && !(await this.keyBelongsTo(key, projectId))) continue;
      controller.abort();
      aborted++;
    }
    this.emit("activity", projectId, `Paused. ${aborted} running agent(s) stopped.`);
    this.emit("change", projectId);
    return aborted;
  }

  async resumeProject(projectId: string): Promise<void> {
    await updateSettings(projectId, { paused: false });
    this.emit("activity", projectId, "Resumed.");
    this.emit("change", projectId);
  }

  /** Busy keys are "<stage>:<id>" where id is a project for some stages and
   * a work item for others, so ownership has to be looked up for the latter. */
  private async keyBelongsTo(key: string, projectId: string): Promise<boolean> {
    const id = key.slice(key.indexOf(":") + 1);
    if (id === projectId) return true;
    const item = await board.getWorkItem(id);
    if (item) return item.projectId === projectId;
    const idea = await ideas.getIdea(id);
    return idea?.projectId === projectId;
  }

  private async resolve(projectId: string, role: AgentRole): Promise<{ project: Project; settings: ProjectSettings; agent: AgentDef } | null> {
    const project = await getProject(projectId);
    if (!project) return null;
    await agentStore.ensureProjectAgents(projectId);
    const agent = await agentStore.findRoleAgent(projectId, role);
    if (!agent) return null;
    return { project, settings: await getSettings(projectId), agent };
  }

  private async projectHeader(project: Project, settings: ProjectSettings): Promise<string> {
    const available = (await listSecrets(project.id)).filter((secret) => secret.exposeToAgents);
    return [
      renderProjectContext(project.name, settings, await runs.monthlySpendUsd(project.id)),
      "",
      renderFacts(await listFacts(project.id)),
      "",
      renderSecrets(
        available.map((secret) => secret.name),
        await hasGitCredentials(project.id),
      ),
    ].join("\n");
  }

  /** Folds any facts a run reported into the shared store. Called after
   * every role's run, since any of them can learn something the next one
   * needs. */
  private async applyFacts(projectId: string, agent: AgentDef, contract: { facts?: FactWrite[] } | null): Promise<void> {
    for (const fact of contract?.facts ?? []) {
      if (!fact.key?.trim() || !fact.value?.trim()) continue;
      await writeFact({
        projectId,
        key: fact.key.trim(),
        value: fact.value.trim(),
        category: fact.category,
        writtenBy: agent.id,
        writtenByLabel: agent.name,
      });
    }
  }

  // ---------------------------------------------------------------- product owner

  /** Turns one inbox idea into epics and their stories. */
  async planIdea(projectId: string, ideaId: string): Promise<void> {
    await this.guard(`plan:${ideaId}`, projectId, async (signal) => {
      const claimed = await ideas.claimIdeaForPlanning(ideaId);
      if (!claimed) return;
      const ctx = await this.resolve(projectId, "product-owner");
      if (!ctx) {
        await ideas.markIdeaFailed(ideaId, "no product owner agent is configured for this project");
        return;
      }

      const existing = await board.listWorkItems(projectId);
      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        "A new idea has been handed to you from the Steering Committee. Break it into epics, each with the stories needed to deliver it. Research the workspace and the web as needed before you decide on the shape.",
        "",
        "## The idea",
        "",
        renderIdea(claimed),
        "",
        "## What is already on the board",
        "",
        renderBoardSummary(existing),
        "",
        "Do not duplicate work that already exists above — if this idea overlaps something already tracked, say so in your notes and only add what is genuinely new.",
      ].join("\n");

      const result = await runAgent<PlanContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-plan",
        outputContract: outputContract("custos-plan", PLAN_SHAPE),
        ideaId,
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);
      if (!result.ok || !result.parsed?.epics?.length) {
        await ideas.markIdeaFailed(ideaId, result.error ?? "the product owner returned no epics");
        return;
      }

      const epicIds: string[] = [];
      for (const epic of result.parsed.epics) {
        if (!epic.title) continue;
        const created = await board.createWorkItem({
          projectId,
          type: "epic",
          title: epic.title,
          description: epic.description ?? "",
          acceptanceCriteria: epic.acceptanceCriteria ?? [],
          priority: epic.priority ?? 100,
          sourceIdeaId: ideaId,
          actor: ctx.agent.id,
        });
        epicIds.push(created.id);
        for (const story of epic.stories ?? []) {
          if (!story.title) continue;
          await board.createWorkItem({
            projectId,
            type: story.type === "bug" ? "bug" : "story",
            title: story.title,
            description: story.description ?? "",
            acceptanceCriteria: story.acceptanceCriteria ?? [],
            priority: story.priority ?? 100,
            parentId: created.id,
            actor: ctx.agent.id,
          });
        }
      }

      await ideas.markIdeaPlanned(ideaId, epicIds);
      this.emit("activity", projectId, `Product owner planned "${claimed.title}" into ${epicIds.length} epic(s).`);
    });
  }

  /** Reviews the backlog and promotes what's genuinely ready to work. */
  async groomBacklog(projectId: string): Promise<void> {
    await this.guard(`groom:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "product-owner");
      if (!ctx) return;

      const backlog = (await board.listWorkItems(projectId)).filter((item) => item.status === "backlog");
      if (!backlog.length) return;

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        "Groom the backlog. For each item below, decide whether it is shaped well enough for an engineer to pick up and finish without coming back to ask you what you meant. Promote the ones that are; revise the ones that are nearly there; comment on the ones that need a decision you can't make yourself.",
        "",
        "Promote conservatively — a ticket in `ready` will be picked up and worked autonomously, so a vague one costs real money. Epics are never worked directly, so only promote an epic once its stories exist and are themselves ready.",
        "",
        "If an item is still blocked on the same thing you already noted in a previous comment and nothing has changed, do NOT add another comment repeating it — re-stating an unchanged blocker on every grooming pass (\"Re-checked: still blocked on X\", \"Re-verified: no change\") only adds noise to the ticket's history without adding information. Only comment on an item when there's something new to say: a changed circumstance, a decision only you can make, or the first time you're flagging a blocker.",
        "",
        "## Backlog",
        "",
        backlog.map((item) => renderWorkItem(item, { includeComments: true })).join("\n\n"),
      ].join("\n");

      const result = await runAgent<GroomContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-groom",
        outputContract: outputContract("custos-groom", GROOM_SHAPE),
      });
      await this.applyFacts(projectId, ctx.agent, result.parsed);
      if (!result.ok || !result.parsed) return;

      const valid = new Set(backlog.map((item) => item.id));
      for (const revision of result.parsed.revise ?? []) {
        if (!revision.id || !valid.has(revision.id)) continue;
        await board.updateWorkItem(revision.id, {
          ...(revision.title ? { title: revision.title } : {}),
          ...(revision.description ? { description: revision.description } : {}),
          ...(revision.acceptanceCriteria ? { acceptanceCriteria: revision.acceptanceCriteria } : {}),
        });
      }
      for (const comment of result.parsed.comments ?? []) {
        if (!comment.id || !valid.has(comment.id) || !comment.body) continue;
        await board.addComment(comment.id, ctx.agent.id, agentStore.displayName(ctx.agent), comment.body);
      }
      let promoted = 0;
      for (const id of result.parsed.promote ?? []) {
        if (!valid.has(id) || !board.canTransition("product-owner", "ready")) continue;
        await board.transitionWorkItem(id, "ready", ctx.agent.id, "shaped and ready to work");
        promoted += 1;
      }
      if (promoted) this.emit("activity", projectId, `Product owner promoted ${promoted} item(s) to ready.`);
    });
  }

  // ------------------------------------------------------- engineering manager

  /** Sizes every ready ticket, picks or creates an agent for each, and
   * moves the ones it assigned into in_progress. */
  async assignReady(projectId: string): Promise<void> {
    await this.guard(`assign:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "engineering-manager");
      if (!ctx) return;

      const all = await board.listWorkItems(projectId);
      const ready = all.filter((item) => item.type !== "epic" && item.status === "ready");
      if (!ready.length) return;
      const roster = await agentStore.listEngineers(projectId);
      const menu = agentStore.listProviderOptions(this.runtime.config);
      const models = await syncFromConfig(
        this.runtime.config,
        menu.filter((option) => option.providerKey === "anthropic").map((option) => option.model),
      );
      const limit = await this.engineerLimit(ctx.project, ctx.settings);
      const inFlight = all.filter((item) => item.status === "in_progress").length;

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        "Size every ticket in the ready column below, then decide which of them to start now. For each one you start: set its complexity and either assign an existing engineer or create a new one and assign that.",
        "",
        `**You decide the fan-out.** Every ticket you assign starts immediately, in its own isolated checkout. ${inFlight} engineer(s) are already working; the ceiling for this project is ${limit} at once.${limit === 1 ? " This project is limited to one engineer at a time (it isn't a git repository, so there are no isolated checkouts to give them)." : ""} Tickets you leave in \`ready\` simply wait until you come back — leaving one there is a real choice, not a failure to decide.`,
        "",
        "## Ready tickets",
        "",
        ready.map((item) => renderWorkItem(item, { includeComments: true })).join("\n\n"),
        "",
        "## Your current engineer roster",
        "",
        renderAgentRoster(roster),
        "",
        "## Provider and model menu",
        "",
        renderModelMenu(models),
      ].join("\n");

      const result = await runAgent<AssignContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-assign",
        outputContract: outputContract("custos-assign", ASSIGN_SHAPE),
      });
      await this.applyFacts(projectId, ctx.agent, result.parsed);
      if (!result.ok || !result.parsed) return;

      // Only provider keys that actually exist may be created against --
      // an agent pinned to a provider Custos doesn't have would fail every
      // request it ever made, silently, at assignment time.
      const knownProviders = new Set(menu.map((option) => option.providerKey));
      // An assignment to an exhausted combination fails on its first request
      // and puts the ticket straight back in the queue, so it's rejected
      // here as well as discouraged in the prompt.
      const unavailable = new Set(models.filter((record) => !isAvailable(record)).map((record) => record.id));
      const tempIds = new Map<string, string>();
      for (const spec of result.parsed.newAgents ?? []) {
        if (!spec.name || !spec.providerKey || !spec.model || !knownProviders.has(spec.providerKey)) continue;
        if (unavailable.has(modelId(spec.providerKey, spec.model))) {
          this.emit("activity", projectId, `Skipped new agent "${spec.name}": ${spec.providerKey}/${spec.model} is exhausted.`);
          continue;
        }
        // The engineering manager's contract still asks for `providerKey`
        // and `model` on a new engineer (see ASSIGN_SHAPE) so it can match
        // each new agent against the menu it's shown. After this commit
        // the agent stores no providerKey/model at all -- the same
        // provider/model picks up a default fallback set whose first entry
        // is that provider/model. We look it up by scanning
        // `config.fallbackSets` for a set whose `providers[0]` matches.
        const matchingSet = Object.entries(this.runtime.config.fallbackSets ?? {}).find(([, set]) => {
          const first = set.providers[0];
          return first && first.provider === spec.providerKey && first.model === spec.model;
        });
        const fallbackSet = matchingSet?.[0] ?? Object.keys(this.runtime.config.fallbackSets ?? {})[0];
        if (!fallbackSet) {
          this.emit("activity", projectId, `Skipped new agent "${spec.name}": no fallback set exists to wrap ${spec.providerKey}/${spec.model}.`);
          continue;
        }
        const created = await agentStore.createAgent({
          projectId,
          role: "engineer",
          name: spec.name,
          fallbackSet,
          specialty: spec.specialty ?? null,
          maxComplexity: spec.maxComplexity ?? "medium",
          systemPrompt: spec.systemPrompt ?? "",
          createdBy: "engineering-manager",
        });
        if (spec.tempId) tempIds.set(spec.tempId, created.id);
        const createdPick = agentStore.primaryPick(created, this.runtime.config);
        this.emit("activity", projectId, `Engineering manager created engineer "${created.name}" on ${createdPick?.providerKey ?? "?"}/${createdPick?.model ?? "?"}.`);
      }

      for (const tune of result.parsed.tuning ?? []) {
        if (!tune.agentId) continue;
        if (tune.note) await agentStore.appendAgentNote(tune.agentId, tune.note);
        // The EM contract still asks for providerKey/model in its tuning
        // entries (see ASSIGN_SHAPE), but post-drop these become "switch
        // to the fallback set whose first entry is this provider/model".
        // We only act on the tuning note when the providerKey/model
        // combination corresponds to a real set -- otherwise the note
        // would be applied against a non-existent fallback chain and the
        // operator's intent would silently vanish.
        const patch: Parameters<typeof agentStore.updateAgent>[1] = {};
        if (tune.maxComplexity) patch.maxComplexity = tune.maxComplexity;
        if (tune.providerKey && tune.model) {
          const matchingSet = Object.entries(this.runtime.config.fallbackSets ?? {}).find(([, set]) => {
            const first = set.providers[0];
            return first && first.provider === tune.providerKey && first.model === tune.model;
          });
          if (matchingSet) patch.fallbackSet = matchingSet[0];
        }
        if (Object.keys(patch).length) await agentStore.updateAgent(tune.agentId, patch);
      }

      const readyIds = new Set(ready.map((item) => item.id));
      // The ceiling is enforced here as well as described in the prompt: an
      // over-eager manager assigning twelve tickets on a project capped at
      // three would otherwise start twelve processes, and the cap exists
      // precisely because the human doesn't want that.
      let slots = Math.max(0, limit - inFlight);
      for (const assignment of result.parsed.assignments ?? []) {
        if (slots <= 0) break;
        if (!assignment.workItemId || !readyIds.has(assignment.workItemId)) continue;
        const agentId = assignment.agentId ?? (assignment.tempId ? tempIds.get(assignment.tempId) : undefined);
        if (!agentId) continue;
        const assignee = await agentStore.getAgent(agentId);
        if (!assignee) continue;
        const pick = agentStore.primaryPick(assignee, this.runtime.config);
        if (pick && unavailable.has(modelId(pick.providerKey, pick.model))) {
          this.emit(
            "activity",
            projectId,
            `Held "${assignment.workItemId}": ${assignee.name} runs on ${pick.providerKey}/${pick.model}, which is exhausted.`,
          );
          continue;
        }
        // Above check used the resolved primary pick; recordOutcome
        // below reads what actually ran (the agent's primary pick at the
        // time of dispatch, which the agent-runner will acquire via
        // resolveFallbackSet).
        slots -= 1;
        await board.updateWorkItem(assignment.workItemId, {
          assigneeAgentId: agentId,
          ...(assignment.complexity ? { complexity: assignment.complexity } : {}),
        });
        await board.transitionWorkItem(assignment.workItemId, "in_progress", ctx.agent.id, assignment.rationale);
        await agentStore.recordAssignment(agentId);
      }
    });
  }

  // ------------------------------------------------------------------ engineer

  async runEngineer(projectId: string, workItemId: string): Promise<void> {
    await this.guard(`engineer:${workItemId}`, projectId, async (signal) => {
      const item = await board.getWorkItem(workItemId);
      if (!item || item.status !== "in_progress" || !item.assigneeAgentId) return;
      const project = await getProject(projectId);
      const agent = await agentStore.getAgent(item.assigneeAgentId);
      if (!project || !agent) return;
      const settings = await getSettings(projectId);

      // Its own checkout, on its own branch: this is what lets several
      // engineers work the same project at once without stepping on each
      // other's edits. Reused across QA bounces so the work survives.
      const workspace = await ensureWorkspace(project.workspaceDir, projectId, item, settings.defaultBranch);
      await board.updateWorkItem(workItemId, {
        worktreePath: workspace.isolated ? workspace.cwd : null,
        ...(workspace.branch ? { branch: workspace.branch } : {}),
      });

      // Project GitHub PATs are injected per agent process as GH_TOKEN; do
      // not test the container's persistent gh login. Probe the same scoped
      // environment before spending an engineer run that cannot deliver.
      const gitEnv = workspace.isolated ? await resolveAgentEnv(projectId) : null;
      if (workspace.isolated) {
        if (!(await hasGitCredentials(projectId))) {
          const backedOff = await board.recordAttemptFailure(workItemId);
          this.emit("activity", projectId, `Held "${item.title}": no project secret is marked for Git use (attempt ${backedOff?.attempts ?? 1}).`);
          return;
        }
        const access = await verifyGitHubAccess(workspace.cwd, gitEnv!);
        if (!access.ok) {
          const backedOff = await board.recordAttemptFailure(workItemId);
          this.emit("activity", projectId, `Held "${item.title}": project GitHub credentials are unusable (attempt ${backedOff?.attempts ?? 1}): ${access.reason}`);
          return;
        }
      }

      const parent = item.parentId ? await board.getWorkItem(item.parentId) : null;
      const prompt = [
        await this.projectHeader(project, settings),
        "",
        "## Your ticket",
        "",
        renderWorkItem(item, { includeComments: true, includeHistory: true }),
        parent ? `\n## The epic this belongs to\n\n${renderWorkItem(parent)}` : "",
        "",
        workspace.isolated
          ? `You are in your own git worktree at \`${workspace.cwd}\`, with branch \`${workspace.branch}\` already checked out for you off \`${settings.defaultBranch}\`. Commit to that branch — do not create another one, and do not switch branches. Other engineers are working other tickets in their own checkouts of this same repository at the same time, so stay within the files this ticket is about.`
          : `This project is not a git repository, so you are working directly in the shared project directory and are the only engineer running. Keep your changes tightly scoped.`,
        "",
        "Work this ticket to completion. When the acceptance criteria are met, push your branch and open a pull request against the default branch. Without a PR, QA cannot review your work — the PR is the only review surface.",
      ].join("\n");

      const result = await runAgent<EngineerContract>(this.runtime, {
        signal,
        agent,
        projectId,
        cwd: workspace.cwd,
        prompt,
        tag: "custos-engineer",
        outputContract: outputContract("custos-engineer", ENGINEER_SHAPE),
        workItemId,
      });

      await this.applyFacts(projectId, agent, result.parsed);
      if (!result.ok || !result.parsed) {
        // Not persisted as a board comment (see the identical note on the
        // QA path below) -- the live activity feed below already surfaces
        // this, and a ticket that keeps failing on a rate-limited/flaky
        // provider would otherwise accumulate an unbounded pile of
        // "Run failed: ..." comments, one per retry, forever.
        const backedOff = await board.recordAttemptFailure(workItemId);
        this.emit("activity", projectId, `${agent.name} failed on "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${result.error ?? "unknown error"}; will retry.`);
        return;
      }
      const contract = result.parsed;
      if (contract.subtasks?.length) {
        await board.setSubtasks(workItemId, contract.subtasks.map((s) => s.title ?? "").filter(Boolean));
      }

      if (contract.status === "blocked") {
        await board.clearAttempts(workItemId);
        // Blocked work goes back to the backlog rather than sitting in
        // in_progress: it needs a product decision, and the backlog is
        // where the product owner looks. Its checkout is released -- the
        // branch keeps whatever was done, and holding a worktree open for a
        // ticket nobody is working just blocks a slot.
        await this.release(project, workItemId);
        await board.transitionWorkItem(workItemId, "backlog", agent.id, contract.blockedReason ?? "blocked");
        this.emit("activity", projectId, `${agent.name} is blocked on "${item.title}": ${contract.blockedReason ?? "no reason given"}`);
        return;
      }

      // A PR URL in the final JSON is only a claim. Verify it against GitHub
      // before allowing QA to run, using the same project-scoped PAT that
      // the engineer received.
      if (workspace.isolated && contract.prUrl && workspace.branch) {
        const delivery = await verifyPullRequest(workspace.cwd, contract.prUrl, workspace.branch, settings.defaultBranch, gitEnv!);
        if (!delivery.ok) {
          const backedOff = await board.recordAttemptFailure(workItemId);
          this.emit("activity", projectId, `${agent.name} could not hand off "${item.title}" to QA (attempt ${backedOff?.attempts ?? 1}): ${delivery.reason}`);
          return;
        }
        contract.prUrl = delivery.url;
      }

      // PR enforcement gate: if the project has a git repository and the
      // engineer didn't open a pull request, warn and keep the ticket
      // in_progress. QA reviews the PR diff, not the whole checkout, so
      // a missing PR means QA has nothing to review. The engineer can be
      // dispatched again (the ticket is still in_progress) and should
      // push its branch and create the PR on the next attempt.
      if (workspace.isolated && !contract.prUrl) {
        const backedOff = await board.recordAttemptFailure(workItemId);
        if ((backedOff?.attempts ?? 1) === 1) {
          await board.addComment(
          workItemId,
          agent.id,
          agentStore.displayName(agent),
          "**No pull request found.** The ticket was marked as complete but no PR was created. QA reviews the PR diff, not the whole checkout — push your branch and open a pull request against the default branch before requesting QA review.",
          );
        }
        this.emit("activity", projectId, `${agent.name} reported "${item.title}" done without a PR (attempt ${backedOff?.attempts ?? 1}); retrying after backoff.`);
        return;
      }

      await board.clearAttempts(workItemId);
      await board.updateWorkItem(workItemId, {
        ...(contract.branch ? { branch: contract.branch } : {}),
        ...(contract.prUrl ? { prUrl: contract.prUrl } : {}),
      });
      const followUps = contract.followUps?.length ? `\n\n**Noticed but not fixed (out of scope for this ticket):**\n${contract.followUps.map((f) => `- ${f}`).join("\n")}` : "";
      const engineerCommentBody = `${contract.summary ?? ""}${followUps}`;
      if (engineerCommentBody.trim()) {
        await board.addComment(workItemId, agent.id, agentStore.displayName(agent), engineerCommentBody);
      }
      await board.transitionWorkItem(workItemId, "qa", agent.id, "ready for QA");
      await agentStore.recordRunResult(agent.id, { completed: true, runMs: result.runMs });
      this.emit("activity", projectId, `${agent.name} finished "${item.title}" and sent it to QA.`);
    });
  }

  // ------------------------------------------------------------------------ QA

  async runQa(projectId: string, workItemId: string): Promise<void> {
    await this.guard(`qa:${workItemId}`, projectId, async (signal) => {
      const item = await board.getWorkItem(workItemId);
      if (!item || item.status !== "qa") return;
      const ctx = await this.resolve(projectId, "qa");
      if (!ctx) return;

      // Review starts with the PR diff. The worktree is available if the
      // QA agent needs to check out and run the code, but the default
      // surface is the pull request diff — reading the diff is faster than
      // re-running the whole build, and inline PR comments let the
      // engineer see exactly which lines the issue is on.
      const reviewCwd = item.worktreePath ?? ctx.project.workspaceDir;
      // Tickets completed before PR-based review was enforced can be in
      // `qa` with a worktree/branch but no prUrl -- there's no PR to read
      // or comment on. Without this branch the prompt below told QA to
      // "read the PR diff" and "post your verdict via `gh pr comment`"
      // regardless, an impossible instruction for a ticket with nothing to
      // diff against or comment on. A model (especially a smaller
      // fallback-tier one) faced with that contradiction tended to give up
      // on reviewing entirely and free-associate off the ticket's
      // description instead, as if it were the one implementing it.
      const hasPr = Boolean(item.prUrl);
      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## The ticket under review",
        "",
        renderWorkItem(item, { includeComments: true, includeHistory: true }),
        "",
        item.worktreePath
          ? hasPr
            ? `The engineer's worktree is at \`${reviewCwd}\` with branch \`${item.branch}\` checked out. Start by reading the PR diff — only check out the branch and run the code if the diff alone can't answer a criterion.`
            : `The engineer's worktree is at \`${reviewCwd}\` with branch \`${item.branch}\` checked out, but no pull request is linked (this ticket predates PR-based review). There is no PR diff to read and no PR to comment on -- instead, from inside \`${reviewCwd}\`, diff the branch against the project's default branch yourself (e.g. \`git diff main...${item.branch}\` or \`git log main..${item.branch} -p\`) to see exactly what changed, then review it the same way you would a PR diff. Post your verdict as a comment on this ticket instead of a PR comment.`
          : item.branch
            ? `The work is on branch \`${item.branch}\`.`
            : "The engineer did not report a branch — find the work yourself before judging it.",
        item.prUrl ? `Pull request: ${item.prUrl} — this is your primary review surface. Read the diff and post your findings as inline PR comments.` : "",
        "",
        hasPr
          ? "Verify each acceptance criterion. Read the PR diff first, then run the code if needed. Post your verdict and findings as comments on the PR — use the `gh pr comment` command. If the work passes, transition the ticket to complete. If it fails, bounce it back to ready."
          : "Verify each acceptance criterion. Diff the branch yourself first, then run the code if needed. Post your verdict and findings as a comment on this ticket (there is no PR to comment on). If the work passes, transition the ticket to complete. If it fails, bounce it back to ready.",
      ].join("\n");

      const result = await runAgent<QaContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: reviewCwd,
        prompt,
        tag: "custos-qa",
        outputContract: outputContract("custos-qa", QA_SHAPE),
        workItemId,
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);
      if (!result.ok || !result.parsed) {
        // Not persisted as a board comment -- a ticket that keeps failing
        // QA on the same transient cause (rate limit, spawn error, flaky
        // provider) would otherwise accumulate an unbounded pile of
        // "QA run failed: ..." comments, one per retry, forever. Two real
        // tickets independently reached 4,000+ comments this way, which
        // pushed the spawned `claude -p` subprocess's argv+environ past the
        // OS's ARG_MAX (EBIG) on every subsequent attempt -- a ticket that
        // could never recover once poisoned. The live activity feed still
        // surfaces the failure without persisting it into ticket history.
        this.emit("activity", projectId, `${ctx.agent.name} QA run failed on "${item.title}": ${result.error ?? "unknown error"}`);
        return;
      }

      const contract = result.parsed;
      const checks = contract.criteriaChecked?.length
        ? `\n\n${contract.criteriaChecked.map((c) => `- **${c.result === "pass" ? "PASS" : "FAIL"}** ${c.criterion ?? ""} — ${c.evidence ?? ""}`).join("\n")}`
        : "";
      const qaCommentBody = `${contract.summary ?? ""}${checks}`;
      // An empty summary with no criteria checked would otherwise post a
      // blank comment -- pure noise, and it's happened in practice with a
      // weaker fallback-tier model that returned a valid contract but an
      // empty summary field.
      if (qaCommentBody.trim()) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), qaCommentBody);
      }

      // Store QA's PR comments on the work item so they surface in the
      // ticket detail UI. The QA agent posts them to the PR via `gh pr
      // comment` during the run, so this is a mirror of what already
      // exists on GitHub — it makes the review visible without leaving
      // the admin panel. Appended to any existing PR comments so earlier
      // QA rounds' comments survive across bounce-rework-re-review cycles.
      // Each comment is stored with a createdAt timestamp so the UI can
      // show real relative times rather than a static "just now" label.
      if (contract.prComments?.length) {
        const existing = (await board.getWorkItem(workItemId))?.prComments ?? [];
        const now = Date.now();
        const newEntries = contract.prComments
          .filter(Boolean)
          .map((text: string) => ({ text, createdAt: now }));
        await board.updateWorkItem(workItemId, { prComments: [...existing, ...newEntries] });
      }

      // QA's verdict is the only honest measure of whether the model that
      // did the work was up to it, so it feeds straight back into that
      // model's capability rating -- which is what the manager reads next
      // time it decides who gets the hard tickets.
      const author = item.assigneeAgentId ? await agentStore.getAgent(item.assigneeAgentId) : null;
      if (author) {
        // Record capability against the *actual* provider/model that ran
        // this ticket, not the agent's primary pick or any stored row
        // field. The agent's fallback chain may have skipped [0] because
        // that provider was rate-limited; if we credited the verdict to
        // [0] instead, the EM's feedback loop would steer away from the
        // wrong model on the next sizing pass. The AgentRun row carries
        // the resolved pair that the agent-runner recorded at dispatch
        // time, which is the only source of truth that matches what
        // actually served the request.
        const latestRuns = await runs.listRuns(item.projectId, 50);
        const thisRun = latestRuns.find((row) => row.agentId === author.id && row.workItemId === item.id);
        if (thisRun) {
          await recordOutcome(thisRun.providerKey, thisRun.model, contract.verdict === "pass" ? "passed" : "bounced");
        }
      }

      // Capture the decisive criterion + evidence onto the engineer's run
      // row so the agent card can show "Last QA bounce: <reason>" inline
      // without re-querying work-item comments on every poll. We pick the
      // first criterion whose result matches the verdict -- a failing
      // criterion when QA bounced (the reason for the bounce), a passing
      // one when QA passed (what kept confidence). Skipped when the QA
      // contract omitted a verdict rather than defaulted to "fail" -- a
      // QA run that parsed cleanly without a verdict is a contract-shaped
      // oddity, not a real bounce, and shouldn't surface one. Done
      // independently of the model-capability feedback above so the
      // surface data lives on its own concern rather than piggy-backing
      // on a feedback loop. The engineer-run lookup uses
      // `listRuns(...).find(...)` rather than tracking an index in
      // memory because listRuns sorts by startedAt DESC and slices to
      // limit, so the FIRST match in iteration order is the most-recent
      // engineer run -- which is the row whose qaBounce should reflect
      // this verdict. The assumption is encoded in a comment so a future
      // sort change makes the surface silently wrong without breaking
      // the typecheck.
      if (contract.verdict) {
        const decisive = contract.criteriaChecked?.find((c) =>
          contract.verdict === "fail" ? c.result === "fail" : c.result === "pass",
        );
        const engineerRuns = await runs.listRuns(item.projectId, 50);
        const engineerRun = engineerRuns.find((row) => row.role === "engineer" && row.workItemId === item.id);
        if (engineerRun) {
          await runs.attachQaBounce(engineerRun.id, {
            verdict: contract.verdict,
            criterion: decisive?.criterion?.trim() || undefined,
            evidence: decisive?.evidence?.trim() || undefined,
          });
        }
      }

      if (contract.verdict === "pass") {
        // Passing frees the checkout for the next ticket. The branch and
        // its pull request survive -- that's where the work actually lives.
        await this.release(ctx.project, workItemId);
        await board.transitionWorkItem(workItemId, "complete", ctx.agent.id, "QA passed");
        this.emit("activity", projectId, `QA passed "${item.title}".`);
        return;
      }

      await board.transitionWorkItem(workItemId, "ready", ctx.agent.id, "QA found problems — needs rework");
      // The bounce is charged to the engineer who produced the work, which
      // is exactly the signal the engineering manager reads back when it
      // decides whether that agent is under-modelled.
      if (item.assigneeAgentId) await agentStore.recordRunResult(item.assigneeAgentId, { qaRejected: true });
      this.emit("activity", projectId, `QA bounced "${item.title}" back to ready for rework.`);
    });
  }

  /** Drops a ticket's checkout and forgets the path. Failures are swallowed:
   * a worktree that can't be removed is wasted disk, not a reason to fail
   * the transition that prompted it. */
  private async release(project: Project, workItemId: string): Promise<void> {
    try {
      await releaseWorkspace(project.workspaceDir, project.id, workItemId);
    } catch {
      // Best effort.
    }
    await board.updateWorkItem(workItemId, { worktreePath: null });
  }

  // ----------------------------------------------------------------- survey

  /**
   * Reads an existing codebase and writes down what the next agent needs to
   * know — build and test commands, stack, conventions, architecture.
   *
   * This is what makes bringing an existing repo into Custos worth doing.
   * Without it every agent starts blind and rediscovers how to run the tests
   * on its own ticket, which is slow, expensive, and inconsistent between
   * them. Run once when a project is created from an existing repository.
   */
  async surveyProject(projectId: string): Promise<void> {
    await this.guard(`survey:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "product-owner");
      if (!ctx) return;

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        `Survey the existing codebase in \`${ctx.project.workspaceDir}\` and record what you learn as facts. This is a read-only pass — do not change, install or commit anything.`,
      ].join("\n");

      const result = await runAgent<{ summary?: string; notes?: string } & { facts?: FactWrite[] }>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        extraSystemPrompt: SURVEY_PROMPT,
        tag: "custos-survey",
        outputContract: outputContract("custos-survey", SURVEY_SHAPE),
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);

      if (!result.ok) {
        this.emit("activity", projectId, `Codebase survey failed: ${result.error ?? "unknown error"}`);
        return;
      }
      if (result.parsed?.summary) {
        await writeFact({
          projectId,
          key: "project.overview",
          value: result.parsed.summary,
          category: "docs",
          writtenBy: ctx.agent.id,
          writtenByLabel: agentStore.displayName(ctx.agent),
        });
      }
      const recorded = (await listFacts(projectId)).length;
      this.emit("activity", projectId, `Codebase survey complete — ${recorded} fact(s) now recorded for this project.`);
    });
  }

  // ------------------------------------------------------- project manager

  /**
   * Asks the Project Manager agent to assign a provider and model to each
   * built-in role based on the project's budget and the available providers.
   * Runs once on the first tick. After this, `pmConfigured` is set to true
   * and the orchestrator never runs the PM again for this project (except on
   * manual re-trigger).
   */
  async assignModels(projectId: string): Promise<void> {
    await this.guard(`assign-models:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "project-manager");
      if (!ctx) return;

      const fallbackSets = this.runtime.config.fallbackSets ?? {};
      const allAgents = await agentStore.listAgents(projectId);
      const roster = allAgents.filter((a) => a.role !== "project-manager" && a.role !== "steering");

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        `This project has a monthly budget of ${ctx.settings.budget.monthlyUsd === null ? "unlimited" : `$${ctx.settings.budget.monthlyUsd}`}. Assign a fallback set to each role below, choosing from the available fallback sets.`,
        "",
        `The following roles need assignments:`,
        ...roster.map((a) => `- **${a.role}**${a.fallbackSet ? ` (currently using "${a.fallbackSet}")` : ` (currently no fallback set assigned)`}`),
        "",
        "## Available fallback sets",
        "",
        ...Object.entries(fallbackSets).map(([key, def]) =>
          `- \`${key}\`: **${def.name}** — ${def.description}. Providers: ${def.providers.map((p) => `${p.provider}/${p.model}`).join(" → ")}`
        ),
        "",
        "## Budget and constraints",
        "",
        ctx.settings.budget.monthlyUsd !== null
          ? `Metered spend: $${await this.runtime.spendTracker.getProjectSpend(projectId).catch(() => 0)} of $${ctx.settings.budget.monthlyUsd} used.`
          : "No budget cap — all providers are available.",
        "",
        "Assign every role. Use the fallback set names exactly as shown.",
      ].join("\n");

      const result = await runAgent<ProjectManagerContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-assign-models",
        outputContract: outputContract("custos-assign-models", ASSIGN_MODELS_SHAPE),
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);

      if (!result.ok || !result.parsed?.assignments?.length) {
        this.emit("activity", projectId, `Project Manager failed: ${result.error ?? "no assignments returned"}`);
        // Don't set pmConfigured so it retries on the next tick.
        return;
      }

      // Build a map of current agents by role for quick lookup.
      const agentByRole = new Map(roster.map((a) => [a.role, a]));
      const knownSets = new Set(Object.keys(this.runtime.config.fallbackSets ?? {}));
      let changed = 0;

      for (const assignment of result.parsed.assignments) {
        if (!assignment.role || !assignment.fallbackSet) continue;
        if (!knownSets.has(assignment.fallbackSet)) {
          this.emit("activity", projectId, `PM: skipped "${assignment.role}" — unknown fallback set "${assignment.fallbackSet}"`);
          continue;
        }
        const agent = agentByRole.get(assignment.role);
        if (!agent) {
          this.emit("activity", projectId, `PM: skipped "${assignment.role}" — no agent found for this role`);
          continue;
        }
        // Only update if the assignment actually changes something.
        if (agent.fallbackSet !== assignment.fallbackSet) {
          await agentStore.updateAgent(agent.id, {
            fallbackSet: assignment.fallbackSet,
          });
          await agentStore.appendAgentNote(
            agent.id,
            `Project Manager assigned fallback set "${assignment.fallbackSet}" for ${assignment.role}${assignment.rationale ? `: ${assignment.rationale}` : ""}`,
          );
          changed++;
        }
      }

      await updateSettings(projectId, { pmConfigured: true, pmLastRunAt: Date.now() });
      this.emit(
        "activity",
        projectId,
        `Project Manager assigned fallback sets to ${changed} role(s): ${result.parsed.assignments.map((a) => `${a.role} → ${a.fallbackSet}`).join(", ")}`,
      );
    });
  }

  // --------------------------------------------------------------- provision

  /**
   * Creates the project's repository. Nothing downstream works without one:
   * engineers have nowhere to branch, QA has nothing to check out, and a
   * repository with no commits can't be split into worktrees, so the whole
   * board would run single-file in a shared directory.
   */
  async provisionRepo(projectId: string): Promise<void> {
    await this.guard(`provision:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "devops");
      if (!ctx) return;
      if (ctx.settings.repoUrl) return; // already stood up

      if (!(await hasGitCredentials(projectId))) {
        this.emit("activity", projectId, "Can't create a repository: no git credentials in the vault. Add a GitHub token in DevOps and mark it 'use for git'.");
        return;
      }

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        `Stand up the repository for this project. Its working copy is \`${ctx.project.workspaceDir}\` — create the remote, initialise it there with a single honest first commit, push, and record where it lives in the shared facts store.`,
        "",
        "Do not scaffold an application. The roadmap decides what gets built; you are only making somewhere for it to go.",
      ].join("\n");

      const result = await runAgent<ProvisionContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-provision",
        outputContract: outputContract("custos-provision", PROVISION_SHAPE),
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);

      if (!result.ok || result.parsed?.status !== "provisioned" || !result.parsed.repoUrl) {
        this.emit("activity", projectId, `Repository provisioning failed: ${result.parsed?.blockedReason ?? result.error ?? "no repository URL returned"}`);
        return;
      }

      await updateSettings(projectId, {
        repoUrl: result.parsed.repoUrl,
        ...(result.parsed.defaultBranch ? { defaultBranch: result.parsed.defaultBranch } : {}),
      });
      this.emit("activity", projectId, `DevOps created the repository: ${result.parsed.repoUrl}`);
    });
  }

  // -------------------------------------------------------------------- devops

  async runDevops(projectId: string, workItemId: string): Promise<void> {
    await this.guard(`devops:${workItemId}`, projectId, async (signal) => {
      const item = await board.getWorkItem(workItemId);
      if (!item || item.labels.includes(DEPLOYED_LABEL)) return;
      const ctx = await this.resolve(projectId, "devops");
      if (!ctx) return;
      if (ctx.settings.deployTarget === "none") return;

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        `## Deployment target: ${ctx.settings.deployTarget}`,
        "",
        deploymentTargetSection(ctx.settings.deployTarget, ctx.settings.deployConfig),
        "",
        Object.entries(ctx.settings.deployConfig).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "_No target-specific settings configured._",
        "",
        ctx.settings.budget.infraMonthlyUsd !== null
          ? `## Infrastructure budget\n\n$${ctx.settings.budget.infraMonthlyUsd.toFixed(2)} per month, hard limit.`
          : "## Infrastructure budget\n\nNo cap is configured, but keep costs proportionate and report your estimate anyway.",
        "",
        "## The work to deploy",
        "",
        renderWorkItem(item, { includeComments: true }),
      ].join("\n");

      const result = await runAgent<DevopsContract>(this.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-devops",
        outputContract: outputContract("custos-devops", DEVOPS_SHAPE),
        workItemId,
      });

      await this.applyFacts(projectId, ctx.agent, result.parsed);
      if (!result.ok || !result.parsed) {
        // Not persisted as a board comment -- see the identical note on
        // the QA path above.
        this.emit("activity", projectId, `${ctx.agent.name} deployment run failed on "${item.title}": ${result.error ?? "unknown error"}`);
        return;
      }

      const contract = result.parsed;
      if ((contract.summary ?? "").trim()) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), contract.summary ?? "");
      }
      // AWS deployments must report the region the resources actually landed
      // in -- the devops gate, not a prompt nicety. The orchestrator is the
      // only place that can enforce this because the LLM-side `awsRegion`
      // field is loose by design.
      if (ctx.settings.deployTarget === "aws" && (!contract.awsRegion || contract.awsRegion.trim() === "")) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), `DevOps deployment missing awsRegion: required when deployTarget is aws.`);
        this.emit("activity", projectId, `DevOps deployment missing awsRegion on "${item.title}". Use the project's deployConfig.awsRegion or report it in the contract.`);
        return;
      }
      if (contract.status !== "deployed") {
        this.emit("activity", projectId, `DevOps is blocked on "${item.title}": ${contract.blockedReason ?? "no reason given"}`);
        return;
      }
      await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
      this.emit("activity", projectId, `DevOps deployed "${item.title}"${contract.estimatedMonthlyUsd ? ` (~$${contract.estimatedMonthlyUsd}/mo)` : ""}${contract.awsRegion ? ` in ${contract.awsRegion}` : ""}.`);
    });
  }
}

/** Per-target guidance injected into the devops agent's prompt. The audit
 * at docs/union-audit.md treats this as the runtime fork that proves
 * `DeployTarget.docker-local` and `DeployTarget.aws` are no longer
 * schema-inert -- the orchestrator narrows on each value rather than
 * string-templating the deployTarget into a generic block. */
function deploymentTargetSection(target: DeployTarget, deployConfig: Record<string, string>): string {
  switch (target) {
    case "docker-local":
      return [
        "### Compose-file target",
        "",
        `Compose file: \`${deployConfig.composePath ?? "./docker-compose.yml"}\``,
        "Bring up: `docker compose up -d`",
        "Verify: `docker compose ps`",
        "",
        "Use the existing compose file in source as the source of truth. Note healthcheck states and service connectivity in your summary. Tail logs before declaring deployed.",
      ].join("\n");
    case "aws":
      return [
        "### AWS target",
        "",
        `Region: \`${deployConfig.awsRegion ?? "(missing — your contract will be blocked)"}\``,
        `Credentials profile (env-resolved): \`${deployConfig.awsProfile ?? "default"}\``,
        "",
        "Read the existing repo's infrastructure code first — Dockerfile, compose, .aws/, terraform/, CloudFormation — and extend it rather than introducing a parallel scheme. Resource limits and idle behaviour come from the conventions in that code.",
        "",
        "Your contract REQUIRES `awsRegion` -- it is the audit trail showing where the resources actually landed. If you cannot determine it from `deployConfig.awsRegion` or the repo's existing infra code, set `status: \"blocked\"` with `blockedReason: \"missing awsRegion\"`.",
      ].join("\n");
    case "none":
      return "_No deployment target configured._";
  }
}

/** Convenience for routes that need to describe a ticket the same way the
 * orchestrator does, without importing the whole context module. */
export function describeWorkItem(item: WorkItem): string {
  return renderWorkItem(item, { includeComments: true, includeHistory: true });
}
