import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import * as board from "../pm/board.js";
import * as agentStore from "../pm/agents.js";
import { isAvailable, modelId, syncFromConfig } from "../pm/model-registry.js";
import { resolveProjectAgent, projectHeader, buildGroomPrompt, buildAssignPrompt } from "../pm/pm-prompts.js";
import { buildSystemPrompt, DISALLOWED_TOOLS_BY_TAG } from "../pm/agent-runner.js";
import { mintGroomSession, mintAssignSession, releaseSession, buildPmMcpConfig } from "../mcp/pm-tools.js";
import { runTurn, type TurnEvent } from "../remote/turn-runner.js";
import { formatModelAlias } from "../providers/model-alias.js";
import { resolveAgentEnv } from "../pm/vault.js";
import { isGitRepo } from "../pm/worktrees.js";

const ABSOLUTE_MAX_ENGINEERS = 12; // mirrors orchestrator.ts's constant of the same name

/**
 * One-shot harness for comparing candidate local models on groomBacklog/
 * assignReady's actual tool-driven prompt -- built for the 2026-08-11
 * investigation into qwen3.5:9b-q4_K_M unreliably using its tools (see the
 * session's commit history: three rounds of prompt tightening on that
 * model each fixed one failure shape and exposed another). Runs the exact
 * same prompt-building + session-minting + tool-serving path production
 * dispatch uses (buildGroomPrompt/buildAssignPrompt from pm-prompts.ts,
 * mintGroomSession/mintAssignSession + the real /mcp/pm-run route from
 * pm-tools.ts) so a candidate that passes here will behave identically
 * in production -- the only substitution is which model answers the
 * prompt (formatModelAlias("local", model) pins the "local" Ollama
 * provider to an arbitrary already-pulled tag, bypassing fallback-set
 * resolution entirely so nothing in config needs to change to test a
 * new candidate).
 *
 * Deliberately NOT wired into any persistent admin UI -- this is a
 * one-off diagnostic surface for an active investigation, called
 * directly with curl. If groomBacklog/assignReady swap to a different
 * model as a result, this route stops being useful and can be deleted;
 * it isn't part of the product.
 *
 * Real side effects: a candidate that actually calls assign_ticket/
 * promote_ticket will make the same real board changes production
 * dispatch would. That's intentional -- a real assignment IS the
 * outcome being evaluated. Comparing multiple candidates against the
 * same ready ticket requires resetting board state between attempts;
 * see the caller-side eval script for that, not this route.
 */
export function registerEvalRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.post("/admin/api/eval/pm-model", async (req, reply) => {
    const { kind, projectId, model } = req.body as { kind?: "groom" | "assign"; projectId?: string; model?: string };
    if (kind !== "groom" && kind !== "assign") {
      reply.code(400);
      return { error: 'kind must be "groom" or "assign"' };
    }
    if (!projectId || !model) {
      reply.code(400);
      return { error: "projectId and model are required" };
    }

    const role = kind === "groom" ? "product-owner" : "engineering-manager";
    const ctx = await resolveProjectAgent(projectId, role);
    if (!ctx) {
      reply.code(404);
      return { error: `project "${projectId}" or its ${role} agent not found` };
    }

    const header = await projectHeader(ctx.project, ctx.settings);
    let prompt: string;
    let token: string;

    if (kind === "groom") {
      const backlog = (await board.listWorkItems(projectId)).filter((item) => item.status === "backlog");
      if (!backlog.length) {
        reply.code(400);
        return { error: "no backlog items to groom right now" };
      }
      prompt = buildGroomPrompt(header, backlog);
      token = mintGroomSession({
        projectId,
        agentId: ctx.agent.id,
        agentName: agentStore.displayName(ctx.agent),
        validTicketIds: new Set(backlog.map((item) => item.id)),
      });
    } else {
      const all = await board.listWorkItems(projectId);
      const ready = all.filter((item) => item.type !== "epic" && item.status === "ready");
      if (!ready.length) {
        reply.code(400);
        return { error: "no ready tickets to assign right now" };
      }
      const roster = await agentStore.listEngineers(projectId);
      const menu = agentStore.listProviderOptions(runtime.config);
      const models = await syncFromConfig(runtime.config, menu.filter((o) => o.providerKey === "anthropic").map((o) => o.model));
      const configured = Math.max(1, Math.min(ctx.settings.maxConcurrentEngineers ?? 1, ABSOLUTE_MAX_ENGINEERS));
      const limit = configured === 1 ? 1 : (await isGitRepo(ctx.project.workspaceDir)) ? configured : 1;
      const inFlight = all.filter((item) => item.status === "in_progress").length;
      prompt = buildAssignPrompt(header, ready, roster, models, inFlight, limit);

      const unavailable = new Set(models.filter((r) => !isAvailable(r)).map((r) => r.id));
      const unavailableFallbackSets = new Set(
        Object.entries(runtime.config.fallbackSets ?? {})
          .filter(([, set]) => {
            const first = set.providers[0];
            return first && unavailable.has(modelId(first.provider, first.model));
          })
          .map(([name]) => name),
      );
      token = mintAssignSession({
        projectId,
        agentId: ctx.agent.id,
        agentName: agentStore.displayName(ctx.agent),
        validTicketIds: new Set(ready.map((item) => item.id)),
        fallbackSetNames: new Set(Object.keys(runtime.config.fallbackSets ?? {})),
        knownAgentIds: new Set(roster.map((a) => a.id)),
        unavailableFallbackSets,
        slotsRemaining: Math.max(0, limit - inFlight),
      });
    }

    const startedAt = Date.now();
    let text = "";
    let turnError: string | null = null;
    let actions: string[] = [];
    try {
      await runTurn(runtime, {
        cwd: ctx.project.workspaceDir,
        prompt,
        appendSystemPrompt: buildSystemPrompt(ctx.agent, undefined, undefined),
        model: formatModelAlias("local", model),
        env: await resolveAgentEnv(projectId),
        hookProfile: "agent",
        disallowedTools: DISALLOWED_TOOLS_BY_TAG[kind === "groom" ? "custos-groom" : "custos-assign"],
        mcpConfig: buildPmMcpConfig(token),
        onEvent: (event: TurnEvent) => {
          if (event.type === "message_final") {
            for (const block of event.content) if (block.type === "text") text += block.text + "\n";
          }
          if (event.type === "turn_complete" && event.isError) turnError = event.resultText || "the turn ended in an error";
          if (event.type === "error") turnError = event.message;
        },
        signal: new AbortController().signal,
      });
    } catch (err) {
      turnError = (err as Error).message;
    } finally {
      // Always release, even on error/timeout -- an eval run that throws
      // shouldn't leave its session pinned in memory until the 45-minute
      // TTL sweep catches it.
      actions = releaseSession(token);
    }

    return {
      model,
      ok: !turnError,
      durationMs: Date.now() - startedAt,
      toolCallCount: actions.length,
      actions,
      endedWithQuestion: /\?\s*$/.test(text.trim()),
      textTail: text.trim().slice(-2000),
      error: turnError,
    };
  });
}
