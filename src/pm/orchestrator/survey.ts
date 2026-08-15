// Survey stage: reads an existing codebase and writes down what the next
// agent needs to know -- build/test commands, stack, conventions,
// architecture. Run once when a project is created from an existing repo.
import * as agentStore from "../agents.js";
import { listFacts, writeFact } from "../facts.js";
import { runAgent } from "../agent-runner.js";
import { resolveProjectAgent, projectHeader } from "../pm-prompts.js";
import { SURVEY_PROMPT, SURVEY_SHAPE, outputContract } from "../prompts.js";
import type { FactWrite } from "../contracts.js";
import { applyFacts } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

/**
 * Reads an existing codebase and writes down what the next agent needs to
 * know — build and test commands, stack, conventions, architecture.
 *
 * This is what makes bringing an existing repo into Custos worth doing.
 * Without it every agent starts blind and rediscovers how to run the tests
 * on its own ticket, which is slow, expensive, and inconsistent between
 * them. Run once when a project is created from an existing repository.
 */
export async function surveyProject(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`survey:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "product-owner");
    if (!ctx) return;

    const prompt = [
      await projectHeader(ctx.project, ctx.settings),
      "",
      "## Your task",
      "",
      `Survey the existing codebase in \`${ctx.project.workspaceDir}\` and record what you learn as facts. This is a read-only pass — do not change, install or commit anything.`,
    ].join("\n");

    const result = await runAgent<{ summary?: string; notes?: string } & { facts?: FactWrite[] }>(orch.runtime, {
      signal,
      agent: ctx.agent,
      projectId,
      cwd: ctx.project.workspaceDir,
      prompt,
      extraSystemPrompt: SURVEY_PROMPT,
      tag: "custos-survey",
      outputContract: outputContract("custos-survey", SURVEY_SHAPE),
    });

    await applyFacts(projectId, ctx.agent, result.parsed);
    const va = { personaName: ctx.agent.personaName, name: ctx.agent.name, role: ctx.agent.role };

    if (!result.ok) {
      if (!result.unavailable) {
        orch.emit("activity", projectId, {
          text: `Codebase survey failed: ${result.error ?? "unknown error"}`,
          slackText: `My codebase survey failed: ${result.error ?? "unknown error"}`,
          agent: va,
        });
      }
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
    orch.emit("activity", projectId, {
      text: `Codebase survey complete — ${recorded} fact(s) now recorded for this project.`,
      slackText: `I finished surveying the codebase — ${recorded} fact(s) now recorded for this project.`,
      agent: va,
    });
  });
}
