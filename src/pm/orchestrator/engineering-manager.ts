// Engineering-manager stage: sizes every ready ticket, picks or creates an
// agent for each, and moves the ones it assigned into in_progress.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import { runAgent } from "../agent-runner.js";
import { mintAssignSession, releaseSession, buildPmMcpConfig } from "../../mcp/pm-tools.js";
import { resolveProjectAgent, projectHeader, buildAssignPrompt } from "../pm-prompts.js";
import { ensureModel, isAvailable } from "../model-registry.js";
import { updateSettings } from "../project-settings.js";
import { engineerLimit, workItemsSignal } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

export async function assignReady(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`assign:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "engineering-manager");
    if (!ctx) return;

    const all = await board.listWorkItems(projectId);
    const ready = all.filter((item) => item.type !== "epic" && item.status === "ready");
    if (!ready.length) return;
    const roster = await agentStore.listEngineers(projectId);
    const fallbackSets = orch.runtime.config.fallbackSets ?? {};
    const limit = await engineerLimit(ctx.project, ctx.settings);
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
      const record = await ensureModel(first.provider, first.model, orch.runtime.config);
      if (!isAvailable(record)) unavailableFallbackSets.add(key);
    }

    const prompt = buildAssignPrompt(await projectHeader(ctx.project, ctx.settings), ready, roster, fallbackSets, unavailableFallbackSets, inFlight, limit);

    const token = mintAssignSession({
      projectId,
      agentId: ctx.agent.id,
      agentName: agentStore.displayName(ctx.agent),
      validTicketIds: new Set(ready.map((item) => item.id)),
      fallbackSetNames: new Set(Object.keys(orch.runtime.config.fallbackSets ?? {})),
      knownAgentIds: new Set(roster.map((a) => a.id)),
      unavailableFallbackSets,
      slotsRemaining: Math.max(0, limit - inFlight),
    });
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent(orch.runtime, {
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
      if (actions.length) orch.emit("activity", projectId, `Engineering manager: ${actions.join("; ")}.`);
    }
    if (!result.ok) {
      if (!result.unavailable) orch.emit("activity", projectId, `Engineering manager assignment pass failed: ${result.error ?? "unknown error"}`);
    } else {
      const freshAll = await board.listWorkItems(projectId);
      const freshReady = freshAll.filter((item) => item.type !== "epic" && item.status === "ready");
      const freshInFlight = freshAll.filter((item) => item.status === "in_progress").length;
      await updateSettings(projectId, { lastAssignSignal: `${workItemsSignal(freshReady)}|inFlight=${freshInFlight}` });
    }
  });
}
