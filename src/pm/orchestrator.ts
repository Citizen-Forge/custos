import { EventEmitter } from "node:events";
import type { Runtime } from "../runtime.js";
import { getProject, listProjects, type Project } from "../remote/projects.js";
import * as board from "./board.js";
import * as ideas from "./ideas.js";
import * as agentStore from "./agents.js";
import * as runs from "./runs.js";
import { getSettings } from "./project-settings.js";
import { runAgent } from "./agent-runner.js";
import { renderAgentRoster, renderBoardSummary, renderIdea, renderProjectContext, renderProviderMenu, renderWorkItem } from "./context.js";
import { ASSIGN_SHAPE, DEVOPS_SHAPE, ENGINEER_SHAPE, GROOM_SHAPE, PLAN_SHAPE, QA_SHAPE, outputContract } from "./prompts.js";
import type { AssignContract, DevopsContract, EngineerContract, GroomContract, PlanContract, QaContract } from "./contracts.js";
import type { AgentDef, AgentRole, ProjectSettings, WorkItem } from "./types.js";

const TICK_MS = Number(process.env.CUSTOS_ORCHESTRATOR_TICK_MS ?? 20_000);

/** How many engineer agents may be mid-ticket on one project at once.
 * Concurrent agents editing the same working copy is the failure mode this
 * guards against as much as cost -- they share one workspace directory. */
const MAX_CONCURRENT_ENGINEERS = 1;

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
   * long engineer run isn't dispatched again by the next tick. */
  private readonly busy = new Set<string>();

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
    return [...this.busy];
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
    if (await this.overBudget(project.id, settings)) return;

    if (settings.autonomy["product-owner"]) {
      const inbox = (await ideas.listIdeas(project.id)).filter((idea) => idea.status === "inbox");
      for (const idea of inbox) void this.planIdea(project.id, idea.id);
      const backlog = (await board.listWorkItems(project.id)).filter((item) => item.status === "backlog");
      if (backlog.length) void this.groomBacklog(project.id);
    }

    if (settings.autonomy["engineering-manager"]) {
      const ready = (await board.listWorkItems(project.id)).filter((item) => item.type !== "epic" && item.status === "ready");
      if (ready.length) void this.assignReady(project.id);
    }

    if (settings.autonomy.engineer) {
      const inProgress = (await board.listWorkItems(project.id)).filter((item) => item.status === "in_progress" && item.assigneeAgentId);
      const live = inProgress.filter((item) => this.busy.has(`engineer:${item.id}`)).length;
      for (const item of inProgress.slice(0, Math.max(0, MAX_CONCURRENT_ENGINEERS - live))) {
        void this.runEngineer(project.id, item.id);
      }
    }

    if (settings.autonomy.qa) {
      for (const item of (await board.listWorkItems(project.id)).filter((i) => i.status === "qa")) {
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

  private async overBudget(projectId: string, settings: ProjectSettings): Promise<boolean> {
    if (settings.budget.monthlyUsd === null) return false;
    const spent = await runs.monthlySpendUsd(projectId);
    if (spent < settings.budget.monthlyUsd) return false;
    this.emit("activity", projectId, `Paused: this month's agent budget ($${settings.budget.monthlyUsd}) is spent.`);
    return true;
  }

  /** Wraps a stage so it can't be double-dispatched and always emits a
   * change when it finishes, whatever the outcome. */
  private async guard<T>(key: string, projectId: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    this.emit("change", projectId);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
      this.emit("change", projectId);
    }
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
    return renderProjectContext(project.name, settings, await runs.monthlySpendUsd(project.id));
  }

  // ---------------------------------------------------------------- product owner

  /** Turns one inbox idea into epics and their stories. */
  async planIdea(projectId: string, ideaId: string): Promise<void> {
    await this.guard(`plan:${ideaId}`, projectId, async () => {
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
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-plan",
        outputContract: outputContract("custos-plan", PLAN_SHAPE),
        ideaId,
      });

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
    await this.guard(`groom:${projectId}`, projectId, async () => {
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
        "## Backlog",
        "",
        backlog.map((item) => renderWorkItem(item, { includeComments: true })).join("\n\n"),
      ].join("\n");

      const result = await runAgent<GroomContract>(this.runtime, {
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-groom",
        outputContract: outputContract("custos-groom", GROOM_SHAPE),
      });
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
        await board.addComment(comment.id, ctx.agent.id, ctx.agent.name, comment.body);
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
    await this.guard(`assign:${projectId}`, projectId, async () => {
      const ctx = await this.resolve(projectId, "engineering-manager");
      if (!ctx) return;

      const ready = (await board.listWorkItems(projectId)).filter((item) => item.type !== "epic" && item.status === "ready");
      if (!ready.length) return;
      const roster = await agentStore.listEngineers(projectId);
      const menu = agentStore.listProviderOptions(this.runtime.config);

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## Your task",
        "",
        "Size and assign every ticket in the ready column below. For each one: set its complexity, then either assign an existing engineer or create a new one and assign that.",
        "",
        `At most ${MAX_CONCURRENT_ENGINEERS} engineer(s) work at a time on this project — they share one working copy — so assign in the order you want them worked, highest value first.`,
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
        renderProviderMenu(menu),
      ].join("\n");

      const result = await runAgent<AssignContract>(this.runtime, {
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-assign",
        outputContract: outputContract("custos-assign", ASSIGN_SHAPE),
      });
      if (!result.ok || !result.parsed) return;

      // Only provider keys that actually exist may be created against --
      // an agent pinned to a provider Custos doesn't have would fail every
      // request it ever made, silently, at assignment time.
      const knownProviders = new Set(menu.map((option) => option.providerKey));
      const tempIds = new Map<string, string>();
      for (const spec of result.parsed.newAgents ?? []) {
        if (!spec.name || !spec.providerKey || !spec.model || !knownProviders.has(spec.providerKey)) continue;
        const created = await agentStore.createAgent({
          projectId,
          role: "engineer",
          name: spec.name,
          providerKey: spec.providerKey,
          model: spec.model,
          specialty: spec.specialty ?? null,
          maxComplexity: spec.maxComplexity ?? "medium",
          systemPrompt: spec.systemPrompt ?? "",
          createdBy: "engineering-manager",
        });
        if (spec.tempId) tempIds.set(spec.tempId, created.id);
        this.emit("activity", projectId, `Engineering manager created engineer "${created.name}" on ${created.providerKey}/${created.model}.`);
      }

      for (const tune of result.parsed.tuning ?? []) {
        if (!tune.agentId) continue;
        if (tune.note) await agentStore.appendAgentNote(tune.agentId, tune.note);
        const patch = {
          ...(tune.providerKey && knownProviders.has(tune.providerKey) ? { providerKey: tune.providerKey } : {}),
          ...(tune.model ? { model: tune.model } : {}),
          ...(tune.maxComplexity ? { maxComplexity: tune.maxComplexity } : {}),
        };
        if (Object.keys(patch).length) await agentStore.updateAgent(tune.agentId, patch);
      }

      const readyIds = new Set(ready.map((item) => item.id));
      for (const assignment of result.parsed.assignments ?? []) {
        if (!assignment.workItemId || !readyIds.has(assignment.workItemId)) continue;
        const agentId = assignment.agentId ?? (assignment.tempId ? tempIds.get(assignment.tempId) : undefined);
        if (!agentId || !(await agentStore.getAgent(agentId))) continue;
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
    await this.guard(`engineer:${workItemId}`, projectId, async () => {
      const item = await board.getWorkItem(workItemId);
      if (!item || item.status !== "in_progress" || !item.assigneeAgentId) return;
      const project = await getProject(projectId);
      const agent = await agentStore.getAgent(item.assigneeAgentId);
      if (!project || !agent) return;
      const settings = await getSettings(projectId);

      const parent = item.parentId ? await board.getWorkItem(item.parentId) : null;
      const prompt = [
        await this.projectHeader(project, settings),
        "",
        "## Your ticket",
        "",
        renderWorkItem(item, { includeComments: true, includeHistory: true }),
        parent ? `\n## The epic this belongs to\n\n${renderWorkItem(parent)}` : "",
        "",
        `Work this ticket to completion on a branch off \`${settings.defaultBranch}\`, then report. You cannot mark it complete yourself — QA will review what you produce.`,
      ].join("\n");

      const result = await runAgent<EngineerContract>(this.runtime, {
        agent,
        projectId,
        cwd: project.workspaceDir,
        prompt,
        tag: "custos-engineer",
        outputContract: outputContract("custos-engineer", ENGINEER_SHAPE),
        workItemId,
      });

      if (!result.ok || !result.parsed) {
        await board.addComment(workItemId, agent.id, agent.name, `Run failed: ${result.error ?? "unknown error"}`);
        return;
      }

      const contract = result.parsed;
      if (contract.subtasks?.length) {
        await board.setSubtasks(workItemId, contract.subtasks.map((s) => s.title ?? "").filter(Boolean));
      }
      await board.updateWorkItem(workItemId, {
        ...(contract.branch ? { branch: contract.branch } : {}),
        ...(contract.prUrl ? { prUrl: contract.prUrl } : {}),
      });
      const followUps = contract.followUps?.length ? `\n\n**Noticed but not fixed (out of scope for this ticket):**\n${contract.followUps.map((f) => `- ${f}`).join("\n")}` : "";
      await board.addComment(workItemId, agent.id, agent.name, `${contract.summary ?? ""}${followUps}`);

      if (contract.status === "blocked") {
        // Blocked work goes back to the backlog rather than sitting in
        // in_progress: it needs a product decision, and the backlog is
        // where the product owner looks.
        await board.transitionWorkItem(workItemId, "backlog", agent.id, contract.blockedReason ?? "blocked");
        this.emit("activity", projectId, `${agent.name} is blocked on "${item.title}": ${contract.blockedReason ?? "no reason given"}`);
        return;
      }

      await board.transitionWorkItem(workItemId, "qa", agent.id, "ready for QA");
      await agentStore.recordRunResult(agent.id, { completed: true, runMs: result.runMs });
      this.emit("activity", projectId, `${agent.name} finished "${item.title}" and sent it to QA.`);
    });
  }

  // ------------------------------------------------------------------------ QA

  async runQa(projectId: string, workItemId: string): Promise<void> {
    await this.guard(`qa:${workItemId}`, projectId, async () => {
      const item = await board.getWorkItem(workItemId);
      if (!item || item.status !== "qa") return;
      const ctx = await this.resolve(projectId, "qa");
      if (!ctx) return;

      const prompt = [
        await this.projectHeader(ctx.project, ctx.settings),
        "",
        "## The ticket under review",
        "",
        renderWorkItem(item, { includeComments: true, includeHistory: true }),
        "",
        item.branch ? `The work is on branch \`${item.branch}\`.` : "The engineer did not report a branch — find the work yourself before judging it.",
        item.prUrl ? `Pull request: ${item.prUrl}` : "",
        "",
        "Verify each acceptance criterion by actually running the code, then decide: pass it, or bounce it back with specific, actionable reasons.",
      ].join("\n");

      const result = await runAgent<QaContract>(this.runtime, {
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-qa",
        outputContract: outputContract("custos-qa", QA_SHAPE),
        workItemId,
      });

      if (!result.ok || !result.parsed) {
        await board.addComment(workItemId, ctx.agent.id, ctx.agent.name, `QA run failed: ${result.error ?? "unknown error"}`);
        return;
      }

      const contract = result.parsed;
      const checks = contract.criteriaChecked?.length
        ? `\n\n${contract.criteriaChecked.map((c) => `- **${c.result === "pass" ? "PASS" : "FAIL"}** ${c.criterion ?? ""} — ${c.evidence ?? ""}`).join("\n")}`
        : "";
      await board.addComment(workItemId, ctx.agent.id, ctx.agent.name, `${contract.summary ?? ""}${checks}`);

      if (contract.verdict === "pass") {
        await board.transitionWorkItem(workItemId, "complete", ctx.agent.id, "QA passed");
        this.emit("activity", projectId, `QA passed "${item.title}".`);
        return;
      }

      await board.transitionWorkItem(workItemId, "in_progress", ctx.agent.id, "QA found problems");
      // The bounce is charged to the engineer who produced the work, which
      // is exactly the signal the engineering manager reads back when it
      // decides whether that agent is under-modelled.
      if (item.assigneeAgentId) await agentStore.recordRunResult(item.assigneeAgentId, { qaRejected: true });
      this.emit("activity", projectId, `QA bounced "${item.title}" back to the engineer.`);
    });
  }

  // -------------------------------------------------------------------- devops

  async runDevops(projectId: string, workItemId: string): Promise<void> {
    await this.guard(`devops:${workItemId}`, projectId, async () => {
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
        agent: ctx.agent,
        projectId,
        cwd: ctx.project.workspaceDir,
        prompt,
        tag: "custos-devops",
        outputContract: outputContract("custos-devops", DEVOPS_SHAPE),
        workItemId,
      });

      if (!result.ok || !result.parsed) {
        await board.addComment(workItemId, ctx.agent.id, ctx.agent.name, `Deployment run failed: ${result.error ?? "unknown error"}`);
        return;
      }

      const contract = result.parsed;
      await board.addComment(workItemId, ctx.agent.id, ctx.agent.name, contract.summary ?? "");
      if (contract.status !== "deployed") {
        this.emit("activity", projectId, `DevOps is blocked on "${item.title}": ${contract.blockedReason ?? "no reason given"}`);
        return;
      }
      await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
      this.emit("activity", projectId, `DevOps deployed "${item.title}"${contract.estimatedMonthlyUsd ? ` (~$${contract.estimatedMonthlyUsd}/mo)` : ""}.`);
    });
  }
}

/** Convenience for routes that need to describe a ticket the same way the
 * orchestrator does, without importing the whole context module. */
export function describeWorkItem(item: WorkItem): string {
  return renderWorkItem(item, { includeComments: true, includeHistory: true });
}
