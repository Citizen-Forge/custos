import { EventEmitter } from "node:events";
import type { Runtime } from "../runtime.js";
import { getProject, listProjects, type Project } from "../remote/projects.js";
import * as board from "./board.js";
import * as ideas from "./ideas.js";
import * as agentStore from "./agents.js";
import * as runs from "./runs.js";
import { getSettings, updateSettings } from "./project-settings.js";
import { listFacts, writeFact, proposeFact, listPendingFacts, listApprovedFacts } from "./facts.js";
import { runAgent } from "./agent-runner.js";
import { mintGroomSession, mintAssignSession, mintCurateSession, mintEngineerSession, releaseSession, lookupSession, buildPmMcpConfig, type EngineerOutcome } from "../mcp/pm-tools.js";
import { resolveProjectAgent, projectHeader as buildProjectHeader, buildGroomPrompt, buildAssignPrompt, buildCuratePrompt } from "./pm-prompts.js";
import { ensureWorkspace, isGitRepo, releaseWorkspace, verifyGitHubAccess, verifyPullRequest, checkPrReadyToMerge, mergePullRequest } from "./worktrees.js";
import { renderAgentRoster, renderBoardSummary, renderIdea, renderWorkItem } from "./context.js";
import { ensureModel, isAvailable } from "./model-registry.js";
import { hasGitCredentials, resolveAgentEnv } from "./vault.js";
import { fetchNewMessages, fetchUserName, isPlainHumanMessage, postMessage, resolveBotUserId, stripBotMention } from "../slack/client.js";
import { buildStatusReply } from "../slack/status.js";
import { DEFAULT_PERSONA } from "../slack/personas.js";
import { ASSIGN_MODELS_SHAPE, DEVOPS_SHAPE, PLAN_SHAPE, PROVISION_SHAPE, QA_SHAPE, SURVEY_PROMPT, SURVEY_SHAPE, outputContract } from "./prompts.js";
import type { DevopsContract, FactWrite, PlanContract, ProjectManagerContract, ProvisionContract, QaContract } from "./contracts.js";
import type { AgentDef, AgentRole, DeployTarget, ProjectSettings, WorkItem } from "./types.js";
import { HUMAN_ASSIGNEE_ID } from "./types.js";

const TICK_MS = Number(process.env.CUSTOS_ORCHESTRATOR_TICK_MS ?? 20_000);

/** Fingerprints a set of work items so tickProject can tell "nothing has
 *  changed since the last pass" from "something's different, worth another
 *  look" without hand-tracking every kind of change (new item, edited
 *  title, a fresh comment, a status flip). `updatedAt` already advances on
 *  all of those; sorting by id makes the fingerprint order-independent, and
 *  a membership change (an item entering or leaving the set) changes the
 *  fingerprint on its own since the list of pairs is a different length. */
function workItemsSignal(items: readonly { id: string; updatedAt: number }[]): string {
  return items
    .map((item) => `${item.id}:${item.updatedAt}`)
    .sort()
    .join(",");
}

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

    // Independent of every autonomy toggle below -- a dropped Slack
    // message becomes an inbox idea the same way a steering-chat handoff
    // does, whether or not this project auto-plans its inbox. Cheap to
    // check every tick: pollSlackIdeas itself no-ops instantly when Slack
    // isn't configured, and guard() already prevents overlap if a poll is
    // still in flight for some reason.
    if (settings.slackChannelId) void this.pollSlackIdeas(project.id);

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

      // Gated on more than just "is there anything to look at" -- a
      // non-empty backlog stays non-empty for as long as its items sit
      // there un-promoted, which used to mean a full grooming pass (one
      // more `claude` spawn) every single tick regardless of whether
      // anything had actually changed since the last one already looked
      // and made its call. Comparing against the fingerprint recorded
      // after the last SUCCESSFUL pass (see workItemsSignal) means "we
      // already considered exactly this" skips the redundant re-ask,
      // while a genuinely new/edited item still triggers one immediately.
      const backlog = (await board.listWorkItems(project.id)).filter((item) => item.status === "backlog");
      if (backlog.length && workItemsSignal(backlog) !== settings.lastGroomSignal) void this.groomBacklog(project.id);

      const pendingFacts = await listPendingFacts(project.id);
      if (pendingFacts.length && workItemsSignal(pendingFacts) !== settings.lastCurateSignal) void this.curateFacts(project.id);
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
    // cents every twenty seconds, indefinitely. Beyond that: even with a
    // free slot, a non-empty ready column that the last pass already looked
    // at (and, correctly or not, decided not to act on) re-triggered every
    // tick for no new reason -- inFlight is folded into the fingerprint
    // alongside the ready items themselves so a slot freeing up (a
    // different ticket completing or bouncing) still counts as something
    // worth another look even when the ready column itself is unchanged.
    if (settings.autonomy["engineering-manager"] && readyWork.length) {
      const limit = await this.engineerLimit(project, settings);
      const inFlight = (await board.listWorkItems(project.id)).filter((item) => item.status === "in_progress").length;
      const assignSignal = `${workItemsSignal(readyWork)}|inFlight=${inFlight}`;
      if (inFlight < limit && assignSignal !== settings.lastAssignSignal) void this.assignReady(project.id);
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

    // Not gated on deployTarget -- devops's first job (merging the PR once
    // QA approved it) applies to every project, deploy target or not. The
    // deploy-target-specific work inside runDevops is what's conditional.
    if (settings.autonomy.devops) {
      const deployable = (await board.listWorkItems(project.id)).filter(
        (item) => item.status === "complete" && !item.labels.includes(DEPLOYED_LABEL) && !board.isBackingOff(item),
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
    } catch (err) {
      // Every dispatch path (engineer/QA/devops/EM/PM tick) routes through
      // here. Each of them already emits its own "activity" line for the
      // failure modes it anticipates (see the many `this.emit("activity", ...)`
      // call sites below), but an *unanticipated* throw -- a bug, a raw
      // Error from deep in a provider call -- skips all of that and used to
      // propagate straight out of guard() as an unhandled rejection, which
      // crashes the whole gateway process (every project, not just this
      // one). This is the last line of defense: log it to the global
      // activity feed so it's visible next to every other failure instead
      // of only surviving in a per-ticket comment (or nowhere), and swallow
      // it so one tick's bug can't take down the process.
      const message = err instanceof Error ? err.message : String(err);
      this.emit("activity", projectId, `${key} failed unexpectedly: ${message}`);
      return null;
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

  // Thin delegates to pm-prompts.ts, which also backs scripts/eval-pm-models.ts
  // -- kept here so the many existing this.resolve(...)/this.projectHeader(...)
  // call sites below don't all need touching for what's otherwise a pure
  // extract-function refactor.
  private async resolve(projectId: string, role: AgentRole): Promise<{ project: Project; settings: ProjectSettings; agent: AgentDef } | null> {
    return resolveProjectAgent(projectId, role);
  }

  private async projectHeader(project: Project, settings: ProjectSettings): Promise<string> {
    return buildProjectHeader(project, settings);
  }

  /** Proposes any facts a run reported for curator review. Called after
   * every role's run, since any of them can learn something the next one
   * needs -- but none of them are trusted to put it straight in front of
   * every other agent unreviewed, same reasoning as the `record_fact`
   * tool's own `proposeFact` path (see mcp/pm-tools.ts). */
  private async applyFacts(projectId: string, agent: AgentDef, contract: { facts?: FactWrite[] } | null): Promise<void> {
    for (const fact of contract?.facts ?? []) {
      if (!fact.key?.trim() || !fact.value?.trim()) continue;
      await proposeFact({
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

  /** Turns new messages in the project's configured Slack channel into
   *  inbox ideas -- the inbound half of the Slack integration (see
   *  slack/activity.ts for the outbound half). Every plain human message
   *  becomes one idea, EXCEPT a message that @-mentions the bot: that
   *  gets an immediate deterministic status reply in-thread instead (see
   *  slack/status.ts) -- "@custos what's in progress?" answers from board
   *  state directly rather than becoming something for the product owner
   *  to plan. No special syntax otherwise; the channel itself is the idea
   *  inbox. Guarded like every other dispatch so an overlapping tick
   *  can't double-poll, though a single HTTP call finishing well within
   *  one tick makes that vanishingly unlikely. */
  async pollSlackIdeas(projectId: string): Promise<void> {
    await this.guard(`slack-poll:${projectId}`, projectId, async () => {
      const slack = this.runtime.config.slack;
      if (!slack?.botToken || slack.enabled === false) return;
      const settings = await getSettings(projectId);
      if (!settings.slackChannelId) return;

      // First poll after a channel is configured: seed the cursor at
      // "now" instead of importing the channel's entire history as
      // ideas. Every poll after that passes the real cursor.
      if (settings.slackLastSeenTs === null) {
        await updateSettings(projectId, { slackLastSeenTs: `${Date.now() / 1000}` });
        return;
      }

      const result = await fetchNewMessages(slack.botToken, settings.slackChannelId, settings.slackLastSeenTs);
      if (!result.ok) {
        console.error(`[slack] failed to poll #${settings.slackChannelId} for project ${projectId}: ${result.error}`);
        return;
      }
      if (!result.messages.length) return;

      const botUserId = await resolveBotUserId(slack.botToken);
      let ideaCreated = false;
      let maxTs = settings.slackLastSeenTs;
      for (const message of result.messages) {
        if (Number(message.ts) > Number(maxTs)) maxTs = message.ts;
        if (!isPlainHumanMessage(message)) continue;

        // "@bot what's in progress?" gets an immediate, deterministic
        // status reply in-thread instead of becoming an idea to plan --
        // see slack/status.ts's doc comment for why this stays a board
        // query rather than a real agent dispatch. Anything that doesn't
        // @-mention the bot is a dropped idea, same as before.
        const mention = botUserId ? stripBotMention(message.text, botUserId) : { mentioned: false, text: message.text };
        if (mention.mentioned) {
          const project = await getProject(projectId);
          if (project) {
            const reply = await buildStatusReply(projectId, project.name);
            const posted = await postMessage(slack.botToken, settings.slackChannelId, reply, DEFAULT_PERSONA, message.ts);
            if (!posted.ok) console.error(`[slack] failed to post status reply for project ${projectId}: ${posted.error}`);
          }
          continue;
        }

        const author = message.user ? await fetchUserName(slack.botToken, message.user) : null;
        const title = message.text.trim().slice(0, 80) || "Idea from Slack";
        const brief = `${message.text.trim()}\n\n_Posted in Slack${author ? ` by ${author}` : ""}._`;
        await ideas.createIdea(projectId, title, brief, null);
        ideaCreated = true;
      }
      await updateSettings(projectId, { slackLastSeenTs: maxTs });
      if (ideaCreated) this.emit("change", projectId);
    });
  }

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

      const prompt = buildGroomPrompt(await this.projectHeader(ctx.project, ctx.settings), backlog);

      const token = mintGroomSession({
        projectId,
        agentId: ctx.agent.id,
        agentName: agentStore.displayName(ctx.agent),
        validTicketIds: new Set(backlog.map((item) => item.id)),
      });
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent(this.runtime, {
          signal,
          agent: ctx.agent,
          projectId,
          cwd: ctx.project.workspaceDir,
          prompt,
          tag: "custos-groom",
          toolDriven: true,
          mcpConfig: buildPmMcpConfig(token),
        });
      } finally {
        const actions = releaseSession(token);
        if (actions.length) this.emit("activity", projectId, `Product owner: ${actions.join("; ")}.`);
      }
      if (!result.ok) {
        // No provider available isn't worth an activity line (or Slack
        // post, now that every activity line posts there) -- nothing was
        // attempted, and the next tick retries for free. See
        // handleDispatchFailure's doc comment for the full reasoning.
        if (!result.unavailable) this.emit("activity", projectId, `Product owner grooming failed: ${result.error ?? "unknown error"}`);
      } else {
        // Fingerprint the POST-pass state, not what was fed in -- whatever
        // the pass itself changed (a promote, a revision) is already
        // accounted for, so the very next tick doesn't immediately see a
        // "different" backlog and re-trigger on the pass's own writes.
        const freshBacklog = (await board.listWorkItems(projectId)).filter((item) => item.status === "backlog");
        await updateSettings(projectId, { lastGroomSignal: workItemsSignal(freshBacklog) });
      }
    });
  }

  /** Reviews facts other agents proposed (via record_fact or a role's
   * contract-based `facts` field) and approves or rejects each one before
   * it can show up in any other agent's prompt. Reuses the product-owner
   * agent/autonomy flag rather than adding a dedicated role -- this is the
   * same kind of judgment call groomBacklog already makes about tickets,
   * just applied to the facts store instead. */
  async curateFacts(projectId: string): Promise<void> {
    await this.guard(`curate:${projectId}`, projectId, async (signal) => {
      const ctx = await this.resolve(projectId, "product-owner");
      if (!ctx) return;

      const pending = await listPendingFacts(projectId);
      if (!pending.length) return;
      const approved = await listApprovedFacts(projectId);

      const prompt = buildCuratePrompt(ctx.project, pending, approved);

      const token = mintCurateSession({
        projectId,
        agentId: ctx.agent.id,
        agentName: agentStore.displayName(ctx.agent),
        validPendingIds: new Set(pending.map((fact) => fact.id)),
      });
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent(this.runtime, {
          signal,
          agent: ctx.agent,
          projectId,
          cwd: ctx.project.workspaceDir,
          prompt,
          tag: "custos-curate",
          toolDriven: true,
          mcpConfig: buildPmMcpConfig(token),
        });
      } finally {
        const actions = releaseSession(token);
        if (actions.length) this.emit("activity", projectId, `Product owner (facts review): ${actions.join("; ")}.`);
      }
      if (!result.ok) {
        if (!result.unavailable) this.emit("activity", projectId, `Facts curation pass failed: ${result.error ?? "unknown error"}`);
      } else {
        const freshPending = await listPendingFacts(projectId);
        await updateSettings(projectId, { lastCurateSignal: workItemsSignal(freshPending) });
      }
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
      const fallbackSets = this.runtime.config.fallbackSets ?? {};
      const limit = await this.engineerLimit(ctx.project, ctx.settings);
      const inFlight = all.filter((item) => item.status === "in_progress").length;

      // An assignment to an exhausted combination fails on its first
      // request and puts the ticket straight back in the queue, so
      // assign_ticket rejects it too (see AssignSession.unavailableFallbackSets),
      // keyed by fallback SET NAME since that's the only field an agent
      // row actually carries -- resolved from each set's FIRST entry only
      // (matching what agentStore.primaryPick would resolve for an agent
      // on that set), via ensureModel directly rather than syncFromConfig.
      // syncFromConfig ensures a ModelRecord for every enabled model
      // across every configured provider -- fine for the admin panel's
      // own model-registry view, but on a project with a fully-scanned
      // OpenRouter/Gemini/OpenAI catalog that's 600+ models, and every one
      // of them used to get rendered into this prompt for a decision that
      // only ever needs the handful of models this project's fallback
      // sets actually reference.
      const unavailableFallbackSets = new Set<string>();
      for (const [key, set] of Object.entries(fallbackSets)) {
        const first = set.providers[0];
        if (!first) continue;
        const record = await ensureModel(first.provider, first.model, this.runtime.config);
        if (!isAvailable(record)) unavailableFallbackSets.add(key);
      }

      const prompt = buildAssignPrompt(await this.projectHeader(ctx.project, ctx.settings), ready, roster, fallbackSets, unavailableFallbackSets, inFlight, limit);

      const token = mintAssignSession({
        projectId,
        agentId: ctx.agent.id,
        agentName: agentStore.displayName(ctx.agent),
        validTicketIds: new Set(ready.map((item) => item.id)),
        fallbackSetNames: new Set(Object.keys(this.runtime.config.fallbackSets ?? {})),
        knownAgentIds: new Set(roster.map((a) => a.id)),
        unavailableFallbackSets,
        slotsRemaining: Math.max(0, limit - inFlight),
      });
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent(this.runtime, {
          signal,
          agent: ctx.agent,
          projectId,
          cwd: ctx.project.workspaceDir,
          prompt,
          tag: "custos-assign",
          toolDriven: true,
          mcpConfig: buildPmMcpConfig(token),
        });
      } finally {
        const actions = releaseSession(token);
        if (actions.length) this.emit("activity", projectId, `Engineering manager: ${actions.join("; ")}.`);
      }
      if (!result.ok) {
        if (!result.unavailable) this.emit("activity", projectId, `Engineering manager assignment pass failed: ${result.error ?? "unknown error"}`);
      } else {
        const freshAll = await board.listWorkItems(projectId);
        const freshReady = freshAll.filter((item) => item.type !== "epic" && item.status === "ready");
        const freshInFlight = freshAll.filter((item) => item.status === "in_progress").length;
        await updateSettings(projectId, { lastAssignSignal: `${workItemsSignal(freshReady)}|inFlight=${freshInFlight}` });
      }
    });
  }

  /** The shared "a per-ticket dispatch failed" bookkeeping for
   *  engineer/QA/devops/provisionRepo -- EXCEPT when the failure was
   *  agent-runner.ts's AgentRunResult.unavailable (no provider in the
   *  fallback chain was dispatchable, or the pre-spawn probe couldn't
   *  reach one): that's not a fault of this ticket, nothing was actually
   *  attempted, and every provider already has its own cooldown/circuit-
   *  breaker. Piling board.recordAttemptFailure's separate, coarser
   *  ticket-level backoff on top of that -- growing to a full hour at
   *  RETRY_DELAYS_MS's ceiling -- meant three engineers sharing one
   *  maxConcurrent:1 local slot could each serve up to an hour's penalty
   *  for what amounts to "someone else had the slot for a few seconds".
   *  Returns null when the caller should just return without touching
   *  attempts/backoff/activity at all (the next ~20s tick retries for
   *  free); otherwise the fresh attempt count for the caller's own
   *  activity message. */
  private async handleDispatchFailure(workItemId: string, unavailable: boolean | undefined): Promise<number | null> {
    if (unavailable) return null;
    const backedOff = await board.recordAttemptFailure(workItemId);
    return backedOff?.attempts ?? 1;
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
          const reason = "no project secret is marked for Git use";
          // A synthetic run row -- no provider was ever contacted -- so this
          // failure shows up in the runs list with a persisted reason
          // instead of only a transient WebSocket activity ping. Observed
          // live: a project's GitHub PAT silently going bad meant every
          // attempt was held right here, before ever reaching runAgent, for
          // over a day -- attempts climbed into the 30s with nothing to show
          // for it in the run history, because nothing was ever recorded.
          const failedRun = await runs.startRun({ projectId, agentId: agent.id, role: "engineer", providerKey: "none", model: "none", billed: false, workItemId, tag: "custos-engineer" });
          await runs.finishRun(failedRun.id, { status: "failed", error: reason });
          this.emit("activity", projectId, `Held "${item.title}": ${reason} (attempt ${backedOff?.attempts ?? 1}).`);
          return;
        }
        const access = await verifyGitHubAccess(workspace.cwd, gitEnv!);
        if (!access.ok) {
          const backedOff = await board.recordAttemptFailure(workItemId);
          const failedRun = await runs.startRun({ projectId, agentId: agent.id, role: "engineer", providerKey: "none", model: "none", billed: false, workItemId, tag: "custos-engineer" });
          await runs.finishRun(failedRun.id, { status: "failed", error: `project GitHub credentials are unusable: ${access.reason}` });
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
        "Work this ticket to completion using your normal tools (Bash, Read, Write, Edit, etc.) exactly as you always have. When the acceptance criteria are met, push your branch and open a pull request against the default branch — without a PR, QA cannot review your work, the PR is the only review surface.",
        "",
        "Reporting your result is different from what you're used to: call `report_ready_for_qa` once you're done, or `report_blocked` if you need a decision only a human or the product owner can make. That tool call IS your result — there is no separate summary block to write, and nothing happens automatically just because the acceptance criteria look met to you. Use `record_fact` only for something durable and cross-cutting the next agent on this project will need, not a note about this ticket.",
      ].join("\n");

      const token = mintEngineerSession({
        projectId,
        agentId: agent.id,
        agentName: agentStore.displayName(agent),
        workItemId,
      });
      let result: Awaited<ReturnType<typeof runAgent>>;
      let outcome: EngineerOutcome | null;
      try {
        result = await runAgent(this.runtime, {
          signal,
          agent,
          projectId,
          cwd: workspace.cwd,
          prompt,
          tag: "custos-engineer",
          toolDriven: true,
          mcpConfig: buildPmMcpConfig(token),
          workItemId,
        });
      } finally {
        const session = lookupSession(token);
        outcome = session?.kind === "engineer" ? session.outcome : null;
        releaseSession(token);
      }

      if (!result.ok || !outcome) {
        // Not persisted as a board comment (see the identical note on the
        // QA path below) -- the live activity feed below already surfaces
        // this, and a ticket that keeps failing on a rate-limited/flaky
        // provider would otherwise accumulate an unbounded pile of
        // "Run failed: ..." comments, one per retry, forever. A clean run
        // that never called report_ready_for_qa/report_blocked (still
        // possible even with the tool call replacing the old JSON block --
        // see mcp/pm-tools.ts's EngineerSession doc comment) is treated the
        // same as any other failure: no result means nothing to act on.
        const attempt = await this.handleDispatchFailure(workItemId, result.unavailable);
        if (attempt === null) return;
        this.emit(
          "activity",
          projectId,
          `${agent.name} failed on "${item.title}" (attempt ${attempt}): ${result.ok ? "did not report a result via report_ready_for_qa or report_blocked" : (result.error ?? "unknown error")}; will retry.`,
        );
        return;
      }
      if (outcome.status === "ready_for_qa" && outcome.subtasks.length) {
        await board.setSubtasks(workItemId, outcome.subtasks.map((s) => s.title).filter(Boolean));
      }

      if (outcome.status === "blocked") {
        await board.clearAttempts(workItemId);
        // Blocked work goes back to the backlog rather than sitting in
        // in_progress: it needs a product decision, and the backlog is
        // where the product owner looks. Its checkout is released -- the
        // branch keeps whatever was done, and holding a worktree open for a
        // ticket nobody is working just blocks a slot.
        await this.release(project, workItemId);
        await board.transitionWorkItem(workItemId, "backlog", agent.id, outcome.reason);
        this.emit("activity", projectId, `${agent.name} is blocked on "${item.title}": ${outcome.reason}`);
        return;
      }

      // A PR URL reported via the tool is only a claim. Verify it against
      // GitHub before allowing QA to run, using the same project-scoped PAT
      // the engineer received.
      if (workspace.isolated && outcome.prUrl && workspace.branch) {
        const delivery = await verifyPullRequest(workspace.cwd, outcome.prUrl, workspace.branch, settings.defaultBranch, gitEnv!);
        if (!delivery.ok) {
          const backedOff = await board.recordAttemptFailure(workItemId);
          this.emit("activity", projectId, `${agent.name} could not hand off "${item.title}" to QA (attempt ${backedOff?.attempts ?? 1}): ${delivery.reason}`);
          return;
        }
        outcome.prUrl = delivery.url;
      }

      // PR enforcement gate: if the project has a git repository and the
      // engineer didn't open a pull request, warn and keep the ticket
      // in_progress. QA reviews the PR diff, not the whole checkout, so
      // a missing PR means QA has nothing to review. The engineer can be
      // dispatched again (the ticket is still in_progress) and should
      // push its branch and create the PR on the next attempt.
      if (workspace.isolated && !outcome.prUrl) {
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
        ...(outcome.branch ? { branch: outcome.branch } : {}),
        ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
      });
      const followUps = outcome.followUps.length ? `\n\n**Noticed but not fixed (out of scope for this ticket):**\n${outcome.followUps.map((f) => `- ${f}`).join("\n")}` : "";
      const engineerCommentBody = `${outcome.summary}${followUps}`;
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
        // No provider being available (result.unavailable) isn't worth an
        // activity line at all -- nothing was attempted, the next ~20s
        // tick retries for free, and with Slack now posting every
        // activity line (see slack/activity.ts), routine concurrency
        // contention would otherwise spam the channel on every tick.
        if (result.unavailable) return;
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

      // Capture the decisive criterion + evidence onto the engineer's run
      // row so the agent card can show "Last QA bounce: <reason>" inline
      // without re-querying work-item comments on every poll. We pick the
      // first criterion whose result matches the verdict -- a failing
      // criterion when QA bounced (the reason for the bounce), a passing
      // one when QA passed (what kept confidence). Skipped when the QA
      // contract omitted a verdict rather than defaulted to "fail" -- a
      // QA run that parsed cleanly without a verdict is a contract-shaped
      // oddity, not a real bounce, and shouldn't surface one. The
      // engineer-run lookup uses
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
        if (!result.unavailable) this.emit("activity", projectId, `Codebase survey failed: ${result.error ?? "unknown error"}`);
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
        if (!result.unavailable) this.emit("activity", projectId, `Project Manager failed: ${result.error ?? "no assignments returned"}`);
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
        // No provider available isn't worth an activity line -- nothing
        // was attempted, and the next tick retries for free (see
        // handleDispatchFailure's doc comment for the full reasoning).
        if (result.unavailable) return;
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

      // -------------------------------------------------------------
      // Deterministic merge gate. No LLM involved: "does the PR have a
      // QA-approved comment" and "is it mergeable" are both plain API
      // reads with an exact yes/no answer. Running a full agent turn to
      // re-derive them on every retry was the direct cause of a real
      // context/cost blowup -- a blocked ticket got redispatched every
      // tick, and each dispatch re-read an ever-growing comment history
      // just to re-ask an LLM the same question. See worktrees.ts's
      // checkPrReadyToMerge for the detailed reasoning.
      if (!item.prUrl) {
        const backedOff = await board.recordAttemptFailure(workItemId);
        this.emit("activity", projectId, `DevOps can't merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): the ticket has no prUrl recorded.`);
        return;
      }
      const gitEnv = await resolveAgentEnv(projectId);
      const gate = await checkPrReadyToMerge(ctx.project.workspaceDir, item.prUrl, gitEnv);
      if (!gate.ready) {
        // "unmergeable" is categorically different from the other block
        // kinds (waiting on QA, GitHub still computing mergeability, a
        // transient read error): those resolve on their own with time,
        // so re-checking on backoff is the right move. A real conflict
        // never will -- the gate only reads GitHub state, it doesn't
        // write code -- so leaving it in `complete` to be re-checked
        // forever just means it sits stuck with nothing able to fix it.
        // Bounce it back to in_progress instead so the engineer dispatch
        // loop picks it up again; worktreePath/branch/prUrl are left
        // untouched (transitionWorkItem doesn't touch them) so the
        // engineer resumes the same checkout and force-pushes the same
        // PR, exactly like the existing QA-bounce-back path already
        // tells it to.
        if (gate.kind === "unmergeable") {
          await board.transitionWorkItem(workItemId, "in_progress", ctx.agent.id, gate.reason);
          await board.addComment(workItemId, "system", "DevOps gate", `Sent back to engineering: ${gate.reason}`);
          this.emit("activity", projectId, `DevOps sent "${item.title}" back to in_progress: ${gate.reason}`);
          return;
        }
        const backedOff = await board.recordAttemptFailure(workItemId);
        // Same reasoning as the missing-PR gate on the engineer path:
        // worth surfacing once so an operator can see why a ticket is
        // stuck, but re-posting the identical reason on every retry is
        // exactly what compounds the ticket's comment history -- and
        // thus every future agent dispatch's prompt size -- without
        // adding new information.
        if ((backedOff?.attempts ?? 1) === 1) {
          await board.addComment(workItemId, "system", "DevOps gate", `Not merged yet: ${gate.reason}`);
        }
        this.emit("activity", projectId, `DevOps gate held "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${gate.reason}`);
        return;
      }
      const merged = await mergePullRequest(ctx.project.workspaceDir, item.prUrl, gitEnv);
      if (!merged.ok) {
        // The gate passed a moment ago but the merge itself failed --
        // a genuine race (someone pushed a conflicting change in
        // between) rather than a re-derivable fact, so this one is
        // worth a comment every time it recurs, not just once.
        const backedOff = await board.recordAttemptFailure(workItemId);
        await board.addComment(workItemId, "system", "DevOps gate", `Merge attempt failed: ${merged.reason}`);
        this.emit("activity", projectId, `DevOps failed to merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${merged.reason}`);
        return;
      }
      await board.addComment(workItemId, "system", "DevOps gate", `Merged pull request ${item.prUrl}.`);

      if (ctx.settings.deployTarget === "none") {
        // Merging was the whole job for a project with nothing to
        // deploy -- no agent dispatch needed at all.
        await board.clearAttempts(workItemId);
        await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
        this.emit("activity", projectId, `DevOps merged the pull request for "${item.title}".`);
        return;
      }

      // -------------------------------------------------------------
      // Past this point the PR is merged and there's an actual
      // deployment target -- this is the part that genuinely needs
      // agent judgement (infra choices, budget estimation, rollback
      // planning), so it's the only part still dispatched as an agent.
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
        "## The work to deploy (already merged)",
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
        const attempt = await this.handleDispatchFailure(workItemId, result.unavailable);
        if (attempt === null) return;
        this.emit("activity", projectId, `${ctx.agent.name} deployment run failed on "${item.title}" (attempt ${attempt}): ${result.error ?? "unknown error"}; will retry.`);
        return;
      }

      const contract = result.parsed;
      // AWS deployments must report the region the resources actually landed
      // in -- the devops gate, not a prompt nicety. The orchestrator is the
      // only place that can enforce this because the LLM-side `awsRegion`
      // field is loose by design.
      if (ctx.settings.deployTarget === "aws" && (!contract.awsRegion || contract.awsRegion.trim() === "")) {
        const backedOff = await board.recordAttemptFailure(workItemId);
        if ((backedOff?.attempts ?? 1) === 1) {
          await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), `DevOps deployment missing awsRegion: required when deployTarget is aws.`);
        }
        this.emit("activity", projectId, `DevOps deployment missing awsRegion on "${item.title}" (attempt ${backedOff?.attempts ?? 1}). Use the project's deployConfig.awsRegion or report it in the contract.`);
        return;
      }
      if (contract.status !== "deployed") {
        const backedOff = await board.recordAttemptFailure(workItemId);
        if ((backedOff?.attempts ?? 1) === 1 && (contract.summary ?? "").trim()) {
          await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), contract.summary ?? "");
        }
        this.emit("activity", projectId, `DevOps is blocked on "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${contract.blockedReason ?? "no reason given"}`);
        return;
      }
      await board.clearAttempts(workItemId);
      if ((contract.summary ?? "").trim()) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), contract.summary ?? "");
      }
      await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
      this.emit(
        "activity",
        projectId,
        `DevOps deployed "${item.title}"${contract.estimatedMonthlyUsd ? ` (~$${contract.estimatedMonthlyUsd}/mo)` : ""}${contract.awsRegion ? ` in ${contract.awsRegion}` : ""}.`,
      );
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
