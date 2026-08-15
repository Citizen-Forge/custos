import type { FastifyInstance } from "fastify";
import type { Runtime } from "../../runtime.js";
import * as agentStore from "../../pm/agents.js";
import type { AgentDef } from "../../pm/types.js";
import { notFound } from "./shared.js";

export function registerAgentRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get("/admin/api/projects/:id/agents", async (req) => {
    const { id } = req.params as { id: string };
    await agentStore.ensureProjectAgents(id);
    // Fallback sets ride along on the agents response so the agent-card
    // dropdown can list them without a second round-trip. The shape is
    // trimmed to the fields the UI actually renders (name, description,
    // first provider chain) — the full sets live in /admin/api/fallback-sets
    // for the Settings panel.
    return {
      agents: await agentStore.listAgents(id),
      providerOptions: agentStore.listProviderOptions(runtime.config),
      fallbackSets: runtime.config.fallbackSets ?? {},
    };
  });

  app.patch("/admin/api/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = (req.body ?? {}) as agentStore.AgentPatch;
    // If the caller assigned a fallbackSet, validate it still exists in
    // config — otherwise the runtime would dispatch to a non-existent set
    // and 503 on every request. Accepting the unknown name silently would
    // be a footgun (the UI dropdown always shows valid sets, but a hand-
    // edited request could still reach here).
    if (body.fallbackSet && !runtime.config.fallbackSets?.[body.fallbackSet]) {
      reply.code(400);
      return { error: `fallback set "${body.fallbackSet}" is not configured` };
    }
    // Role-locked sets (e.g. "principal") are rejected inside updateAgent
    // itself, which is the one place that already has the agent's role in
    // hand -- surfaced here as a clean 400 rather than the framework's
    // default 500 for an unhandled rejection.
    let agent: AgentDef | null;
    try {
      agent = await agentStore.updateAgent(agentId, body);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    if (!agent) return notFound(reply, "agent");
    return { agent };
  });

  app.delete("/admin/api/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    if (!(await agentStore.deleteAgent(agentId))) return notFound(reply, "agent");
    return { ok: true };
  });
}
