// Product-owner stages: reviewing the backlog, reviewing proposed facts,
// and turning one inbox idea into epics/stories. All three run as the
// project's product-owner agent.
import * as board from "../board.js";
import * as ideas from "../ideas.js";
import * as agentStore from "../agents.js";
import { listPendingFacts, listApprovedFacts } from "../facts.js";
import { runAgent } from "../agent-runner.js";
import { mintGroomSession, mintCurateSession, releaseSession, buildPmMcpConfig } from "../../mcp/pm-tools.js";
import { resolveProjectAgent, projectHeader, buildGroomPrompt, buildCuratePrompt } from "../pm-prompts.js";
import { renderBoardSummary, renderIdea } from "../context.js";
import { PLAN_SHAPE, outputContract } from "../prompts.js";
import type { PlanContract } from "../contracts.js";
import { updateSettings } from "../project-settings.js";
import { applyFacts, workItemsSignal } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

/** Reviews the backlog and promotes what's genuinely ready to work. */
export async function groomBacklog(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`groom:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "product-owner");
    if (!ctx) return;

    const backlog = (await board.listWorkItems(projectId)).filter((item) => item.status === "backlog");
    if (!backlog.length) return;

    const prompt = buildGroomPrompt(await projectHeader(ctx.project, ctx.settings), backlog);

    const token = mintGroomSession({
      projectId,
      agentId: ctx.agent.id,
      agentName: agentStore.displayName(ctx.agent),
      validTicketIds: new Set(backlog.map((item) => item.id)),
    });
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent(orch.runtime, {
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
      if (actions.length) orch.emit("activity", projectId, `Product owner: ${actions.join("; ")}.`);
    }
    if (!result.ok) {
      // No provider available isn't worth an activity line (or Slack
      // post, now that every activity line posts there) -- nothing was
      // attempted, and the next tick retries for free. See
      // handleDispatchFailure's doc comment for the full reasoning.
      if (!result.unavailable) orch.emit("activity", projectId, `Product owner grooming failed: ${result.error ?? "unknown error"}`);
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
export async function curateFacts(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`curate:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "product-owner");
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
      result = await runAgent(orch.runtime, {
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
      if (actions.length) orch.emit("activity", projectId, `Product owner (facts review): ${actions.join("; ")}.`);
    }
    if (!result.ok) {
      if (!result.unavailable) orch.emit("activity", projectId, `Facts curation pass failed: ${result.error ?? "unknown error"}`);
    } else {
      const freshPending = await listPendingFacts(projectId);
      await updateSettings(projectId, { lastCurateSignal: workItemsSignal(freshPending) });
    }
  });
}

/** Turns one inbox idea into epics and their stories. */
export async function planIdea(orch: Orchestrator, projectId: string, ideaId: string): Promise<void> {
  await orch.guard(`plan:${ideaId}`, projectId, async (signal) => {
    const claimed = await ideas.claimIdeaForPlanning(ideaId);
    if (!claimed) return;
    const ctx = await resolveProjectAgent(projectId, "product-owner");
    if (!ctx) {
      await ideas.markIdeaFailed(ideaId, "no product owner agent is configured for this project");
      return;
    }

    const existing = await board.listWorkItems(projectId);
    const prompt = [
      await projectHeader(ctx.project, ctx.settings),
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

    const result = await runAgent<PlanContract>(orch.runtime, {
      signal,
      agent: ctx.agent,
      projectId,
      cwd: ctx.project.workspaceDir,
      prompt,
      tag: "custos-plan",
      outputContract: outputContract("custos-plan", PLAN_SHAPE),
      ideaId,
    });

    await applyFacts(projectId, ctx.agent, result.parsed);
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
    orch.emit("activity", projectId, `Product owner planned "${claimed.title}" into ${epicIds.length} epic(s).`);
  });
}
