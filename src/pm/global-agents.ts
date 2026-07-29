import { agents, createAgent } from "./agents.js";
import type { AgentDef, GlobalSystemRole } from "./types.js";

/** The "factory default" for each built-in global service. Captures the
 * name, specialty and the fallback set identity — the actual provider /
 * model pair is derived at runtime from the named set via
 * `primaryPick(agent, config)`, not stored here. This means a global service
 * created today automatically picks up an operator's later edits to the
 * fallback set's provider chain without needing a migration. */
const BUILTIN_GLOBAL_AGENTS: ReadonlyArray<{
  systemRole: GlobalSystemRole;
  name: string;
  fallbackSet: string;
  specialty: string;
}> = [
  {
    systemRole: "memoryCurator",
    name: "Memory Curator",
    fallbackSet: "standard",
    specialty: "Extracts durable, semantically useful facts from past sessions into long-term memory",
  },
  {
    systemRole: "permissionClassifier",
    name: "Permission Classifier",
    fallbackSet: "fast",
    specialty: "Gates tool calls: allow, deny, or ask a human before each side-effectful action",
  },
  {
    systemRole: "embeddings",
    name: "Embeddings",
    fallbackSet: "standard",
    specialty: "Vector embeddings for the memory store and semantic recall",
  },
];

/** Seed the agents.json collection with one agent per built-in global
 * service. Idempotent — only fills rows whose `systemRole` is missing —
 * so an install with a hand-edited memory curator is left alone.
 *
 * Called once from index.ts on startup, after `runtime.reload()` so the
 * configured providers exist; a global whose fallbackSet doesn't yet
 * exist in config is still inserted (the agent row IS the configured spec
 * — the runtime's responsibility is to surface that the upstream isn't
 * reachable, not to refuse to write the row). */
export async function ensureGlobalAgents(): Promise<AgentDef[]> {
  const created: AgentDef[] = [];
  for (const spec of BUILTIN_GLOBAL_AGENTS) {
    const existing = await agents.find((row) => row.kind === "global" && row.systemRole === spec.systemRole);
    if (existing.length) continue;
    // Nominal role — the orchestrator never looks up a global by role
    // because findRoleAgent() excludes kind === "global" rows. The value is
    // cosmetic and only influences the unused-notes renderer in the agent
    // detail card.
    created.push(await createAgent({
      projectId: null,
      kind: "global",
      systemRole: spec.systemRole,
      role: "engineer",
      name: spec.name,
      fallbackSet: spec.fallbackSet,
      specialty: spec.specialty,
      createdBy: "system",
    }));
  }
  return created;
}

/** The single agent the runtime should consult for a given built-in
 * service. Returns null when the global is missing — caller decides
 * whether that's a fatal config error or a soft skip. */
export async function getGlobalAgent(systemRole: GlobalSystemRole): Promise<AgentDef | null> {
  const rows = await agents.find((row) => row.kind === "global" && row.systemRole === systemRole && row.active);
  return rows[0] ?? null;
}

/** All global agents, used by the admin UI's Global Services panel. */
export async function listGlobalAgents(): Promise<AgentDef[]> {
  return agents.find((row) => row.kind === "global");
}

/** Constants for splatting into the admin UI's preset dropdown. */
export const GLOBAL_AGENT_PRESETS = BUILTIN_GLOBAL_AGENTS.map((spec) => ({
  systemRole: spec.systemRole,
  name: spec.name,
  fallbackSet: spec.fallbackSet,
  specialty: spec.specialty,
}));
