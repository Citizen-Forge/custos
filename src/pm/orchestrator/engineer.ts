// Engineer stage: works one in_progress ticket to a pull request (or a
// reported blocker) in its own git worktree.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import * as runs from "../runs.js";
import { getProject } from "../../remote/projects.js";
import { getSettings } from "../project-settings.js";
import { runAgent } from "../agent-runner.js";
import { mintEngineerSession, releaseSession, lookupSession, buildPmMcpConfig, type EngineerOutcome } from "../../mcp/pm-tools.js";
import { renderWorkItem } from "../context.js";
import { ensureWorkspace, verifyGitHubAccess, verifyPullRequest } from "../worktrees.js";
import { hasGitCredentials, resolveAgentEnv } from "../vault.js";
import { projectHeader } from "../pm-prompts.js";
import { handleDispatchFailure, release } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

export async function runEngineer(orch: Orchestrator, projectId: string, workItemId: string): Promise<void> {
  await orch.guard(`engineer:${workItemId}`, projectId, async (signal) => {
    const item = await board.getWorkItem(workItemId);
    if (!item || item.status !== "in_progress" || !item.assigneeAgentId) return;
    const project = await getProject(projectId);
    const agent = await agentStore.getAgent(item.assigneeAgentId);
    if (!project || !agent) return;
    const settings = await getSettings(projectId);
    // Built once and reused across every emit below -- the agent doesn't
    // change mid-run, only which line it's attributed to does.
    const va = { personaName: agent.personaName, name: agent.name, role: agent.role };

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
        orch.emit("activity", projectId, {
          text: `Held "${item.title}": ${reason} (attempt ${backedOff?.attempts ?? 1}).`,
          slackText: `I'm held on "${item.title}": ${reason} (attempt ${backedOff?.attempts ?? 1}).`,
          agent: va,
        });
        return;
      }
      const access = await verifyGitHubAccess(workspace.cwd, gitEnv!);
      if (!access.ok) {
        const backedOff = await board.recordAttemptFailure(workItemId);
        const failedRun = await runs.startRun({ projectId, agentId: agent.id, role: "engineer", providerKey: "none", model: "none", billed: false, workItemId, tag: "custos-engineer" });
        await runs.finishRun(failedRun.id, { status: "failed", error: `project GitHub credentials are unusable: ${access.reason}` });
        orch.emit("activity", projectId, {
          text: `Held "${item.title}": project GitHub credentials are unusable (attempt ${backedOff?.attempts ?? 1}): ${access.reason}`,
          slackText: `I'm held on "${item.title}": project GitHub credentials are unusable (attempt ${backedOff?.attempts ?? 1}): ${access.reason}`,
          agent: va,
        });
        return;
      }
    }

    const parent = item.parentId ? await board.getWorkItem(item.parentId) : null;
    const prompt = [
      await projectHeader(project, settings),
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
      result = await runAgent(orch.runtime, {
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
      const attempt = await handleDispatchFailure(workItemId, result.unavailable);
      if (attempt === null) return;
      const reason = result.ok ? "did not report a result via report_ready_for_qa or report_blocked" : (result.error ?? "unknown error");
      orch.emit("activity", projectId, {
        text: `${agent.name} failed on "${item.title}" (attempt ${attempt}): ${reason}; will retry.`,
        slackText: `I failed on "${item.title}" (attempt ${attempt}): ${reason}. I'll retry.`,
        agent: va,
      });
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
      await release(project, workItemId);
      await board.transitionWorkItem(workItemId, "backlog", agent.id, outcome.reason);
      orch.emit("activity", projectId, {
        text: `${agent.name} is blocked on "${item.title}": ${outcome.reason}`,
        slackText: `I'm blocked on "${item.title}": ${outcome.reason}`,
        agent: va,
      });
      return;
    }

    // A PR URL reported via the tool is only a claim. Verify it against
    // GitHub before allowing QA to run, using the same project-scoped PAT
    // the engineer received.
    if (workspace.isolated && outcome.prUrl && workspace.branch) {
      const delivery = await verifyPullRequest(workspace.cwd, outcome.prUrl, workspace.branch, settings.defaultBranch, gitEnv!);
      if (!delivery.ok) {
        const backedOff = await board.recordAttemptFailure(workItemId);
        orch.emit("activity", projectId, {
          text: `${agent.name} could not hand off "${item.title}" to QA (attempt ${backedOff?.attempts ?? 1}): ${delivery.reason}`,
          slackText: `I couldn't hand off "${item.title}" to QA (attempt ${backedOff?.attempts ?? 1}): ${delivery.reason}`,
          agent: va,
        });
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
      orch.emit("activity", projectId, {
        text: `${agent.name} reported "${item.title}" done without a PR (attempt ${backedOff?.attempts ?? 1}); retrying after backoff.`,
        slackText: `I reported "${item.title}" done, but I didn't open a PR (attempt ${backedOff?.attempts ?? 1}). I'll retry after backoff.`,
        agent: va,
      });
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
    orch.emit("activity", projectId, {
      text: `${agent.name} finished "${item.title}" and sent it to QA.`,
      slackText: `I finished "${item.title}" and sent it to QA.`,
      agent: va,
    });
  });
}
