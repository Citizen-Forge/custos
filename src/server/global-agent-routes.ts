import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { agents, primaryPick, updateAgent, type AgentPatch } from "../pm/agents.js";
import { listGlobalAgents } from "../pm/global-agents.js";
import type { AgentDef, GlobalSystemRole } from "../pm/types.js";

// Operator-facing editable fields for a global service. With the
// schema cleanup dropping `providerKey`/`model` from AgentDef, the
// only direct provider/model customization lives on the embeddings
// agent via `embeddingBaseUrl` (a per-agent URL override). Everything
// else is selected via `fallbackSet` -- the runtime derives the
// dispatch target from `fallbackSet[0]`, so the admin UI picks a
// fallback set rather than a (provider, model) pair.
type EditableField = "name" | "fallbackSet" | "active" | "embeddingBaseUrl";
const EDITABLE_FIELDS: ReadonlySet<EditableField> = new Set([
  "name",
  "fallbackSet",
  "active",
  "embeddingBaseUrl",
]);

const VALID_SYSTEM_ROLES: ReadonlySet<GlobalSystemRole> = new Set([
  "memoryCurator",
  "permissionClassifier",
  "embeddings",
]);/** Wire-format shape returned to the admin UI. Strips `createdBy` (no
 *  UI uses it), `createdAt` (display-only project metadata), `stats`
 *  (operational telemetry, set by the runtime), `notes` (EM-tuning
 *  history, not relevant for global agents which the EM doesn't tune),
 *  and other fields the admin panel doesn't render — keeps the wire
 *  payload small and the surface explicit. Adds a derived
 *  `providerKey`/`model` pair so the UI can label the agent's
 *  current dispatch target without a second round-trip through
 *  fallbackSets. */
interface GlobalAgentView {
  id: string;
  kind: AgentDef["kind"];
  systemRole: AgentDef["systemRole"];
  name: string;
  fallbackSet: string | null;
  active: boolean;
  embeddingBaseUrl: string | undefined;
  updatedAt: number;
  providerKey: string | null;
  model: string | null;
}

function toView(agent: AgentDef, runtime: Runtime): GlobalAgentView {
  const pick = primaryPick(agent, runtime.config);
  return {
    id: agent.id,
    kind: agent.kind,
    systemRole: agent.systemRole,
    name: agent.name,
    fallbackSet: agent.fallbackSet ?? null,
    active: agent.active,
    embeddingBaseUrl: agent.embeddingBaseUrl,
    updatedAt: agent.updatedAt,
    providerKey: pick?.providerKey ?? null,
    model: pick?.model ?? null,
  };
}

export function registerGlobalAgentRoutes(app: FastifyInstance, runtime: Runtime): void {
  // GET is intentionally cheap (no per-project fetch) so the admin UI's
  // boot-time loadState can include global agents in the same trip
  // as `/admin/api/state`.
  app.get("/admin/api/global-agents", async () => {
    const rows = await listGlobalAgents();
    return { agents: rows.map((row) => toView(row, runtime)) };
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
      if (k === "fallbackSet") {
        // Sanity-check the named set exists in config; otherwise the
        // runtime would dispatch to a non-existent set and 503 on every
        // request (see agents.listProviderOptions and the comment in
        // pm-routes.ts for the matching project-agent check).
        if (typeof v === "string" && v && !runtime.config.fallbackSets?.[v]) {
          reply.code(400);
          return { error: `fallbackSet "${v}" is not configured — add it first under Fallback sets` };
        }
        (patch as Record<string, unknown>).fallbackSet = v || undefined;
        continue;
      }
      (patch as Record<string, unknown>)[k] = v;
    }
    const updated = await updateAgent(target.id, patch);
    if (!updated) {
      reply.code(500);
      return { error: "agent update returned null — collection write may have failed" };
    }
    // The embeddings row is the only one whose fallbackSet (which
    // affects the provider it dispatches to) or embeddingBaseUrl affects
    // runtime.embedding directly via Runtime.refreshEmbedding(). The
    // other globals are read by the curator / classifier handlers on
    // every invocation, so no explicit refresh is needed for them --
    // they pick up the new value on the next call.
    if (systemRole === "embeddings") {
      await runtime.refreshEmbedding();
    }
    return { agent: toView(updated, runtime) };
  });
}
