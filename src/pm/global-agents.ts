import { agents, createAgent } from "./agents.js";
import type { AgentDef, GlobalSystemRole } from "./types.js";

/** The built-in global service roster the gateway seeds on first boot.
 * Each entry is the "factory default" for its `systemRole` and is only
 * inserted if no row already exists with that systemRole, so a hand-tuned
 * curator survives an upgrade that adds new globals.
 *
 * Pick the cheap-and-correct defaults: a local Ollama model for the
 * curator (it runs cheaply in the background), an Ollama-fast chat model
 * for the per-turn permission classifier (must be fast; sits on every
 * tool call), and Ollama's nomic-embed-text for embeddings (matches the
 * existing embeddingProvider default in CONFIG). */
const BUILTIN_GLOBAL_AGENTS: ReadonlyArray<{
  systemRole: GlobalSystemRole;
  name: string;
  providerKey: string;
  model: string;
  specialty: string;
}> = [
  {
    systemRole: "memoryCurator",
    name: "Memory Curator",
    providerKey: "ollama",
    model: "qwen2.5:14b-instruct-q4_K_M",
    specialty: "Extracts durable, semantically useful facts from past sessions into long-term memory",
  },
  {
    systemRole: "permissionClassifier",
    name: "Permission Classifier",
    providerKey: "ollama-fast",
    model: "qwen2.5:3b-instruct",
    specialty: "Gates tool calls: allow, deny, or ask a human before each side-effectful action",
  },
  {
    systemRole: "embeddings",
    name: "Embeddings",
    providerKey: "ollama",
    model: "nomic-embed-text",
    specialty: "Vector embeddings for the memory store and semantic recall",
  },
];

/** Seed the agents.json collection with one agent per built-in global
 * service. Idempotent — only fills rows whose `systemRole` is missing —
 * so an install with a hand-edited memory curator is left alone.
 *
 * Called once from index.ts on startup, after `runtime.reload()` so the
 * configured providers exist; a global whose `providerKey` doesn't match
 * any configured provider is still inserted (the agent row IS the
 * configured spec — the runtime's responsibility is to surface that the
 * upstream isn't reachable, not to refuse to write the row). */
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
      providerKey: spec.providerKey,
      model: spec.model,
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
  providerKey: spec.providerKey,
  model: spec.model,
  specialty: spec.specialty,
}));
