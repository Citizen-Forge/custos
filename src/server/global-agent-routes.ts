import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { agents, updateAgent, type AgentPatch } from "../pm/agents.js";
import { listGlobalAgents } from "../pm/global-agents.js";
import type { AgentDef, GlobalSystemRole } from "../pm/types.js";

type EditableField = "name" | "providerKey" | "model" | "active" | "embeddingBaseUrl";
const EDITABLE_FIELDS: ReadonlySet<EditableField> = new Set([
  "name",
  "providerKey",
  "model",
  "active",
  "embeddingBaseUrl",
]);

const VALID_SYSTEM_ROLES: ReadonlySet<GlobalSystemRole> = new Set([
  "memoryCurator",
  "permissionClassifier",
  "embeddings",
]);

/** Wire-format shape returned to the admin UI. Strips `createdBy` (no
 *  UI uses it), `createdAt` (display-only project metadata), `stats`
 * (operational telemetry, set by the runtime), `notes` (EM-tuning
 *  history, not relevant for global agents which the EM doesn't tune),
 *  and other fields the admin panel doesn't render — keeps the wire
 *  payload small and the surface explicit. */
type GlobalAgentView = Pick<
  AgentDef,
  "id" | "kind" | "systemRole" | "name" | "providerKey" | "model" | "active" | "embeddingBaseUrl" | "updatedAt"
>;

function toView(agent: AgentDef): GlobalAgentView {
  return {
    id: agent.id,
    kind: agent.kind,
    systemRole: agent.systemRole,
    name: agent.name,
    providerKey: agent.providerKey,
    model: agent.model,
    active: agent.active,
    embeddingBaseUrl: agent.embeddingBaseUrl,
    updatedAt: agent.updatedAt,
  };
}

export function registerGlobalAgentRoutes(app: FastifyInstance, runtime: Runtime): void {
  // GET is intentionally cheap (no per-project fetch) so the admin UI's
  // boot-time loadState can include global agents in the same trip
  // as `/admin/api/state`.
  app.get("/admin/api/global-agents", async () => {
    const rows = await listGlobalAgents();
    return { agents: rows.map(toView) };
  });

  app.patch("/admin/api/global-agents/:systemRole", async (req, reply) => {
    const { systemRole } = req.params as { systemRole: string };
    if (!VALID_SYSTEM_ROLES.has(systemRole as GlobalSystemRole)) {
      reply.code(400);
      return { error: `unknown systemRole "${systemRole}"` };
    }
    const rows = await agents.find((row) => row.kind === "global" && row.systemRole === systemRole);
    const target = rows[0];
    if (!target) {
      reply.code(404);
      return { error: `no global agent for "${systemRole}" — restart the gateway to seed the built-in globals` };
    }
    const body = req.body as Partial<Record<EditableField, unknown>>;
    const patch: AgentPatch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!EDITABLE_FIELDS.has(k as EditableField)) continue;
      if (k === "embeddingBaseUrl") {
        // Treats null/"" as clear; otherwise stores as-is. The runtime
        // re-derives the URL from the named providerKey when this field
        // is unset.
        (patch as Record<string, unknown>).embeddingBaseUrl = v || undefined;
        continue;
      }
      (patch as Record<string, unknown>)[k] = v;
    }
    // Sanity check: the runtime stores a numeric providerKey against
    // names like "ollama" / "anthropic" — refuse unknown ones so a
    // typo doesn't accidentally route memory curation at a hostname
    // that doesn't exist. The check is against runtime.config.providers
    // (post-reload), so a provider added by the user in the same minute
    // is reachable.
    if (patch.providerKey !== undefined && typeof patch.providerKey === "string") {
      const providers = runtime.config.providers ?? {};
      const legacy = runtime.config.openaiCompatibleInstances ?? {};
      if (patch.providerKey !== "anthropic" && !providers[patch.providerKey] && !legacy[patch.providerKey]) {
        reply.code(400);
        return { error: `providerKey "${patch.providerKey}" is not configured — add it first under Model providers` };
      }
    }
    const updated = await updateAgent(target.id, patch);
    if (!updated) {
      reply.code(500);
      return { error: "agent update returned null — collection write may have failed" };
    }
    // The embeddings row is the only one whose model/providerKey/baseUrl
    // affects runtime.embedding directly via Runtime.refreshEmbedding().
    // The other globals are read by the curator / classifier handlers
    // on every invocation, so no explicit refresh is needed for them —
    // they pick up the new value on the next call.
    if (systemRole === "embeddings") {
      await runtime.refreshEmbedding();
    }
    return { agent: toView(updated) };
  });
}
