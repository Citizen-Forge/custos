// Project-manager stage: assigns a provider/model fallback set to each
// built-in role based on the project's budget and the available providers.
// Runs once on the first tick; after that pmConfigured is set and the
// orchestrator never runs the PM again for this project (except on manual
// re-trigger).
import * as agentStore from "../agents.js";
import { runAgent } from "../agent-runner.js";
import { resolveProjectAgent, projectHeader } from "../pm-prompts.js";
import { ASSIGN_MODELS_SHAPE, outputContract } from "../prompts.js";
import type { ProjectManagerContract } from "../contracts.js";
import { updateSettings } from "../project-settings.js";
import { applyFacts } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

/**
 * Asks the Project Manager agent to assign a provider and model to each
 * built-in role based on the project's budget and the available providers.
 * Runs once on the first tick. After this, `pmConfigured` is set to true
 * and the orchestrator never runs the PM again for this project (except on
 * manual re-trigger).
 */
export async function assignModels(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`assign-models:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "project-manager");
    if (!ctx) return;

    const fallbackSets = orch.runtime.config.fallbackSets ?? {};
    const allAgents = await agentStore.listAgents(projectId);
    const roster = allAgents.filter((a) => a.role !== "project-manager" && a.role !== "steering");

    const prompt = [
      await projectHeader(ctx.project, ctx.settings),
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
        ? `Metered spend: $${await orch.runtime.spendTracker.getProjectSpend(projectId).catch(() => 0)} of $${ctx.settings.budget.monthlyUsd} used.`
        : "No budget cap — all providers are available.",
      "",
      "Assign every role. Use the fallback set names exactly as shown.",
    ].join("\n");

    const result = await runAgent<ProjectManagerContract>(orch.runtime, {
      signal,
      agent: ctx.agent,
      projectId,
      cwd: ctx.project.workspaceDir,
      prompt,
      tag: "custos-assign-models",
      outputContract: outputContract("custos-assign-models", ASSIGN_MODELS_SHAPE),
    });

    await applyFacts(projectId, ctx.agent, result.parsed);

    if (!result.ok || !result.parsed?.assignments?.length) {
      if (!result.unavailable) orch.emit("activity", projectId, `Project Manager failed: ${result.error ?? "no assignments returned"}`);
      // Don't set pmConfigured so it retries on the next tick.
      return;
    }

    // Build a map of current agents by role for quick lookup.
    const agentByRole = new Map(roster.map((a) => [a.role, a]));
    const knownSets = new Set(Object.keys(orch.runtime.config.fallbackSets ?? {}));
    let changed = 0;

    for (const assignment of result.parsed.assignments) {
      if (!assignment.role || !assignment.fallbackSet) continue;
      if (!knownSets.has(assignment.fallbackSet)) {
        orch.emit("activity", projectId, `PM: skipped "${assignment.role}" — unknown fallback set "${assignment.fallbackSet}"`);
        continue;
      }
      const agent = agentByRole.get(assignment.role);
      if (!agent) {
        orch.emit("activity", projectId, `PM: skipped "${assignment.role}" — no agent found for this role`);
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
    orch.emit(
      "activity",
      projectId,
      `Project Manager assigned fallback sets to ${changed} role(s): ${result.parsed.assignments.map((a) => `${a.role} → ${a.fallbackSet}`).join(", ")}`,
    );
  });
}
