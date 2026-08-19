import { EventEmitter } from "node:events";
import type { Runtime } from "../runtime.js";
import { getProject, listProjects, type Project } from "../remote/projects.js";
import * as board from "./board.js";
import * as ideas from "./ideas.js";
import * as runs from "./runs.js";
import { getSettings, updateSettings } from "./project-settings.js";
import { listPendingFacts } from "./facts.js";
import type { AgentDef, ProjectSettings } from "./types.js";
import { HUMAN_ASSIGNEE_ID } from "./types.js";
import { engineerLimit, workItemsSignal, isAssignCheckStale, isGroomCheckStale } from "./orchestrator/shared.js";
import { groomBacklog, curateFacts, planIdea } from "./orchestrator/product-owner.js";
import { pollSlackIdeas } from "./orchestrator/slack-inbox.js";
import { assignReady } from "./orchestrator/engineering-manager.js";
import { escalateStuckTickets, escalateTicketManually, type EscalationResult } from "./orchestrator/escalation.js";
import { runEngineer } from "./orchestrator/engineer.js";
import { runQa } from "./orchestrator/qa.js";
import { surveyProject } from "./orchestrator/survey.js";
import { assignModels } from "./orchestrator/project-manager.js";
import { provisionRepo, runDevops, DEPLOYED_LABEL } from "./orchestrator/devops.js";

const TICK_MS = Number(process.env.CUSTOS_ORCHESTRATOR_TICK_MS ?? 20_000);

/** The fields of an acting agent an activity line needs to speak in its
 *  voice -- a narrow slice of AgentDef rather than the whole record, so a
 *  stage module doesn't need a full agent fetch just to attribute a line
 *  it already has the agent object for. */
export interface ActivityAgent {
  personaName: string | null;
  name: string;
  role: AgentDef["role"];
}

/** One activity event, rendered differently by its two listeners (see
 *  server/pm-events.ts and slack/activity.ts). `text` is the operator-
 *  facing line the admin UI's toast shows -- third person, unchanged
 *  from before this type existed. `slackText`, when set, is the SAME
 *  event spoken in the acting agent's own first-person voice for Slack,
 *  posted under that agent's persona (see slack/personas.ts) instead of
 *  the generic Custos identity. System-level events with no natural
 *  first-person voice (budget exceeded, a run stalled, the project
 *  paused) omit both `slackText` and `agent` and just post `text` under
 *  the default persona -- there's no "I" for a message about the
 *  project itself. */
export interface ActivityMessage {
  text: string;
  slackText?: string;
  agent?: ActivityAgent;
}

export interface OrchestratorEvents {
  change: [projectId: string];
  activity: [projectId: string, message: ActivityMessage];
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
 *
 * This class itself only owns tick scheduling, dispatch isolation (guard(),
 * the busy map), and the pause/resume killswitch. Each role's actual
 * dispatch logic (prompt building, contract handling, board transitions)
 * lives in its own module under ./orchestrator/ -- product-owner.ts,
 * engineering-manager.ts, engineer.ts, qa.ts, devops.ts, project-manager.ts,
 * survey.ts, slack-inbox.ts -- and is wired back in below as thin
 * one-line delegates so the public API (and every existing
 * `orchestrator.runEngineer(...)`-style call site) is unchanged.
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Keys of the form "<stage>:<id>" for work currently in flight, so a
   * long engineer run isn't dispatched again by the next tick. Each maps to
   * the controller that can abort it, which is what makes the killswitch
   * immediate rather than "stops starting new things". */
  private readonly busy = new Map<string, AbortController>();

  constructor(public readonly runtime: Runtime) {
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
      this.emit("activity", project.id, {
        text: `${stalled.role} has done nothing for ${minutes}m — last action: ${stalled.currentAction ?? "none recorded"}`,
      });
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
      //
      // That fingerprint can become a genuine fixed point, though: a
      // backlog ticket blocked on something external (most commonly "PR
      // #N is QA-approved but unmerged" in its own groom comment) leaves
      // the backlog itself completely unchanged once the PR actually
      // merges -- confirmed live, 19 tickets sat un-promoted for 10 days
      // after their blocking PR merged, because none of the tickets
      // themselves were ever edited. isGroomCheckStale forces a recheck
      // at least once an hour regardless of the fingerprint, so a
      // resolved blocker doesn't sit unnoticed indefinitely.
      const backlog = (await board.listWorkItems(project.id)).filter((item) => item.status === "backlog");
      const groomChanged = backlog.length > 0 && workItemsSignal(backlog) !== settings.lastGroomSignal;
      const groomStale = backlog.length > 0 && isGroomCheckStale(settings.lastGroomCheckedAt, Date.now());
      if (groomChanged || groomStale) void this.groomBacklog(project.id);

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
    //
    // That fingerprint can become a genuine fixed point, though: a ready
    // ticket blocked on something external (a PR merge landing, a
    // credential being fixed) leaves both the ready set AND inFlight
    // unchanged indefinitely while nothing else moves -- confirmed live,
    // three tickets sat in ready for four days after their blocking PR
    // actually merged, because inFlight had settled at 0 both before and
    // after the last pass. isAssignCheckStale forces a recheck at least
    // once an hour regardless of the fingerprint, so a resolved blocker
    // doesn't sit unnoticed indefinitely.
    if (settings.autonomy["engineering-manager"] && readyWork.length) {
      const limit = await engineerLimit(project, settings);
      const inFlight = (await board.listWorkItems(project.id)).filter((item) => item.status === "in_progress").length;
      const assignSignal = `${workItemsSignal(readyWork)}|inFlight=${inFlight}`;
      const changed = assignSignal !== settings.lastAssignSignal;
      const stale = isAssignCheckStale(settings.lastAssignCheckedAt, Date.now());
      if (inFlight < limit && (changed || stale)) void this.assignReady(project.id);
    }

    // Fire-and-forget like every other stage here -- a ticket it
    // reassigns becomes dispatchable on the NEXT tick, once
    // clearAttempts() has actually landed. The engineer block below
    // dispatches by assigneeAgentId + status alone, regardless of which
    // role that agent has, so no other wiring is needed for the
    // principal's own runs to happen.
    if (settings.autonomy.principal) void this.escalateStuckTickets(project.id);

    if (settings.autonomy.engineer) {
      const limit = await engineerLimit(project, settings);
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

  private async overBudget(projectId: string, settings: ProjectSettings): Promise<boolean> {
    if (settings.budget.monthlyUsd === null) return false;
    const spent = await this.runtime.spendTracker.getProjectSpend(projectId);
    if (spent < settings.budget.monthlyUsd) return false;
    this.emit("activity", projectId, { text: `Paused: this month's agent budget ($${settings.budget.monthlyUsd}) is spent.` });
    return true;
  }

  /** Wraps a stage so it can't be double-dispatched and always emits a
   * change when it finishes, whatever the outcome. Public (not private):
   * every stage module under ./orchestrator/ calls back into this via the
   * `orch` instance it's handed, since dispatch isolation is the one piece
   * of genuinely stateful coordination that has to stay here. */
  async guard<T>(key: string, projectId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
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
      // call sites in the stage modules), but an *unanticipated* throw -- a
      // bug, a raw Error from deep in a provider call -- skips all of that
      // and used to propagate straight out of guard() as an unhandled
      // rejection, which crashes the whole gateway process (every project,
      // not just this one). This is the last line of defense: log it to the
      // global activity feed so it's visible next to every other failure
      // instead of only surviving in a per-ticket comment (or nowhere), and
      // swallow it so one tick's bug can't take down the process.
      const message = err instanceof Error ? err.message : String(err);
      this.emit("activity", projectId, { text: `${key} failed unexpectedly: ${message}` });
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
    this.emit("activity", projectId, { text: `Paused. ${aborted} running agent(s) stopped.` });
    this.emit("change", projectId);
    return aborted;
  }

  async resumeProject(projectId: string): Promise<void> {
    await updateSettings(projectId, { paused: false });
    this.emit("activity", projectId, { text: "Resumed." });
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

  // ---------------------------------------------------------------- product owner

  async pollSlackIdeas(projectId: string): Promise<void> {
    return pollSlackIdeas(this, projectId);
  }

  async planIdea(projectId: string, ideaId: string): Promise<void> {
    return planIdea(this, projectId, ideaId);
  }

  async groomBacklog(projectId: string): Promise<void> {
    return groomBacklog(this, projectId);
  }

  async curateFacts(projectId: string): Promise<void> {
    return curateFacts(this, projectId);
  }

  // ------------------------------------------------------- engineering manager

  async assignReady(projectId: string): Promise<void> {
    return assignReady(this, projectId);
  }

  // ------------------------------------------------------------------- escalation

  async escalateStuckTickets(projectId: string): Promise<void> {
    return escalateStuckTickets(this, projectId);
  }

  /** Human override, called from the ticket detail UI's "Escalate"
   *  button -- see orchestrator/escalation.ts's doc comment. */
  async escalateTicketManually(projectId: string, workItemId: string): Promise<EscalationResult> {
    return escalateTicketManually(this, projectId, workItemId);
  }

  // ------------------------------------------------------------------ engineer

  async runEngineer(projectId: string, workItemId: string): Promise<void> {
    return runEngineer(this, projectId, workItemId);
  }

  // ------------------------------------------------------------------------ QA

  async runQa(projectId: string, workItemId: string): Promise<void> {
    return runQa(this, projectId, workItemId);
  }

  // ----------------------------------------------------------------- survey

  async surveyProject(projectId: string): Promise<void> {
    return surveyProject(this, projectId);
  }

  // ------------------------------------------------------- project manager

  async assignModels(projectId: string): Promise<void> {
    return assignModels(this, projectId);
  }

  // --------------------------------------------------------------- provision

  async provisionRepo(projectId: string): Promise<void> {
    return provisionRepo(this, projectId);
  }

  // -------------------------------------------------------------------- devops

  async runDevops(projectId: string, workItemId: string): Promise<void> {
    return runDevops(this, projectId, workItemId);
  }
}
