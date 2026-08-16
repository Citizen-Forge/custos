// QA stage: reviews an engineer's pull request (or, for legacy tickets
// predating PR-based review, a raw branch diff) against the ticket's
// acceptance criteria.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import * as runs from "../runs.js";
import { runAgent } from "../agent-runner.js";
import { mintQaSession, releaseSession, lookupSession, buildPmMcpConfig, type QaOutcome } from "../../mcp/pm-tools.js";
import { resolveProjectAgent, projectHeader } from "../pm-prompts.js";
import { renderWorkItem } from "../context.js";
import { release } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

export async function runQa(orch: Orchestrator, projectId: string, workItemId: string): Promise<void> {
  await orch.guard(`qa:${workItemId}`, projectId, async (signal) => {
    const item = await board.getWorkItem(workItemId);
    if (!item || item.status !== "qa") return;
    const ctx = await resolveProjectAgent(projectId, "qa");
    if (!ctx) return;
    const va = { personaName: ctx.agent.personaName, name: ctx.agent.name, role: ctx.agent.role };

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
      await projectHeader(ctx.project, ctx.settings),
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
        ? "Verify each acceptance criterion. Read the PR diff first, then run the code if needed. Post inline findings as comments on the PR — use the `gh pr comment` command."
        : "Verify each acceptance criterion. Diff the branch yourself first, then run the code if needed.",
      "",
      "Reporting your result is different from what you're used to: call `report_qa_verdict` once you've reached a verdict. That tool call IS your result — there is no separate summary block to write, and nothing transitions the ticket automatically just because you believe the work passes or fails. Use `record_fact` only for something durable and cross-cutting the next agent on this project will need, not a note about this ticket.",
    ].join("\n");

    const token = mintQaSession({
      projectId,
      agentId: ctx.agent.id,
      agentName: agentStore.displayName(ctx.agent),
      workItemId,
    });
    let result: Awaited<ReturnType<typeof runAgent>>;
    let outcome: QaOutcome | null;
    try {
      result = await runAgent(orch.runtime, {
        signal,
        agent: ctx.agent,
        projectId,
        cwd: reviewCwd,
        prompt,
        tag: "custos-qa",
        toolDriven: true,
        mcpConfig: buildPmMcpConfig(token),
        workItemId,
      });
    } finally {
      const session = lookupSession(token);
      outcome = session?.kind === "qa" ? session.outcome : null;
      releaseSession(token);
    }

    if (!result.ok || !outcome) {
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
      const reason = result.ok ? "did not report a verdict via report_qa_verdict" : (result.error ?? "unknown error");
      orch.emit("activity", projectId, {
        text: `${ctx.agent.name} QA run failed on "${item.title}": ${reason}`,
        slackText: `My QA run failed on "${item.title}": ${reason}`,
        agent: va,
      });
      return;
    }

    const checks = outcome.criteriaChecked.length
      ? `\n\n${outcome.criteriaChecked.map((c) => `- **${c.result === "pass" ? "PASS" : "FAIL"}** ${c.criterion} — ${c.evidence}`).join("\n")}`
      : "";
    const qaCommentBody = `${outcome.summary}${checks}`;
    // An empty summary with no criteria checked would otherwise post a
    // blank comment -- pure noise, and it's happened in practice with a
    // weaker fallback-tier model that returned an empty summary field.
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
    if (outcome.prComments.length) {
      const existing = (await board.getWorkItem(workItemId))?.prComments ?? [];
      const now = Date.now();
      const newEntries = outcome.prComments
        .filter(Boolean)
        .map((text: string) => ({ text, createdAt: now }));
      await board.updateWorkItem(workItemId, { prComments: [...existing, ...newEntries] });
    }

    // Capture the decisive criterion + evidence onto the engineer's run
    // row so the agent card can show "Last QA bounce: <reason>" inline
    // without re-querying work-item comments on every poll. We pick the
    // first criterion whose result matches the verdict -- a failing
    // criterion when QA bounced (the reason for the bounce), a passing
    // one when QA passed (what kept confidence). The engineer-run lookup
    // uses `listRuns(...).find(...)` rather than tracking an index in
    // memory because listRuns sorts by startedAt DESC and slices to
    // limit, so the FIRST match in iteration order is the most-recent
    // engineer run -- which is the row whose qaBounce should reflect
    // this verdict. The assumption is encoded in a comment so a future
    // sort change makes the surface silently wrong without breaking
    // the typecheck.
    {
      const decisive = outcome.criteriaChecked.find((c) =>
        outcome.verdict === "fail" ? c.result === "fail" : c.result === "pass",
      );
      const engineerRuns = await runs.listRuns(item.projectId, 50);
      const engineerRun = engineerRuns.find((row) => row.role === "engineer" && row.workItemId === item.id);
      if (engineerRun) {
        await runs.attachQaBounce(engineerRun.id, {
          verdict: outcome.verdict,
          criterion: decisive?.criterion?.trim() || undefined,
          evidence: decisive?.evidence?.trim() || undefined,
        });
      }
    }

    if (outcome.verdict === "pass") {
      // Passing frees the checkout for the next ticket. The branch and
      // its pull request survive -- that's where the work actually lives.
      await release(ctx.project, workItemId);
      await board.transitionWorkItem(workItemId, "complete", ctx.agent.id, "QA passed");
      orch.emit("activity", projectId, {
        text: `QA passed "${item.title}".`,
        slackText: `I passed "${item.title}".`,
        agent: va,
      });
      return;
    }

    await board.transitionWorkItem(workItemId, "ready", ctx.agent.id, "QA found problems — needs rework");
    // The bounce is charged to the engineer who produced the work, which
    // is exactly the signal the engineering manager reads back when it
    // decides whether that agent is under-modelled.
    if (item.assigneeAgentId) await agentStore.recordRunResult(item.assigneeAgentId, { qaRejected: true });
    orch.emit("activity", projectId, {
      text: `QA bounced "${item.title}" back to ready for rework.`,
      slackText: `I bounced "${item.title}" back to ready for rework.`,
      agent: va,
    });
  });
}
