// Create/update/delete paths for agent records.
import { newId } from "../store.js";
import { pickPersonaName } from "../personas.js";
import type { AgentDef, AgentRole, Complexity, CostProfile, GlobalSystemRole } from "../types.js";
import { agents, emptyStats } from "./store.js";

/** Reserved fallback set names that may only ever be assigned to the one
 *  role they exist for. "principal" is real, metered Anthropic usage
 *  gated behind the escalation stage's 5-failed-attempts trigger (see
 *  orchestrator/escalation.ts) -- not something a PM tuning pass, an EM
 *  creating a specialist, or an admin edit should be able to hand to a
 *  regular engineer, however accidentally. Extend this map rather than
 *  special-casing "principal" by name if a similar single-consumer set
 *  is added later. */
const ROLE_LOCKED_FALLBACK_SETS: Partial<Record<string, AgentRole>> = {
  principal: "principal",
};

/** Throws if `fallbackSet` is reserved for a different role than `role`.
 *  Called from both createAgent and updateAgent so every write path --
 *  admin PATCH, the EM's create_engineer/tune_engineer, the PM's
 *  fallback-set reassignment -- goes through the same invariant instead
 *  of each caller re-implementing (or forgetting) the check. */
export function assertFallbackSetAllowed(role: AgentRole, fallbackSet: string | undefined): void {
  if (!fallbackSet) return;
  const lockedTo = ROLE_LOCKED_FALLBACK_SETS[fallbackSet];
  if (lockedTo && lockedTo !== role) {
    throw new Error(`fallback set "${fallbackSet}" is reserved for the "${lockedTo}" role and cannot be assigned to a "${role}" agent`);
  }
}

export interface CreateAgentInput {
  projectId: string | null;
  role: AgentRole;
  name: string;
  /** Persona name override (for tests and seed data); defaults to a random
   *  generated name when unset. */
  personaName?: string;
  systemPrompt?: string;
  specialty?: string | null;
  maxComplexity?: Complexity;
  createdBy?: AgentDef["createdBy"];
  costProfile?: CostProfile | null;
  /** Fallback set name to use for dispatch. Required for project agents;
   *  the runtime resolves the agent's primary pick and routed dispatch
   *  through `fallbackSet[0]` (with per-request failover over the
   *  remaining entries). For project agents this is normally assigned by
   *  the Project Manager; for global agents it comes from
   *  GLOBAL_AGENT_FALLBACK_SET[systemRole]. */
  fallbackSet?: string;
  /** Pass "global" + `systemRole` for project-orthogonal services (memory
   *  curator, permission classifier, embeddings). Defaults to "project". */
  kind?: AgentDef["kind"];
  systemRole?: GlobalSystemRole;
  /** Embeddings endpoint base URL, only meaningful when
   *  `systemRole === "embeddings"`. See AgentDef.embeddingBaseUrl for
   *  the precedence chain. */
  embeddingBaseUrl?: string;
}

export async function createAgent(input: CreateAgentInput): Promise<AgentDef> {
  assertFallbackSetAllowed(input.role, input.fallbackSet);
  const now = Date.now();
  const taken = (await agents.list()).map((agent) => agent.personaName).filter((name): name is string => !!name);
  return agents.insert({
    id: newId(),
    projectId: input.projectId,
    kind: input.kind ?? "project",
    systemRole: input.systemRole,
    role: input.role,
    name: input.name,
    personaName: input.personaName ?? pickPersonaName(taken),
    fallbackSet: input.fallbackSet,
    embeddingBaseUrl: input.embeddingBaseUrl,
    systemPrompt: input.systemPrompt ?? "",
    specialty: input.specialty ?? null,
    createdBy: input.createdBy ?? "human",
    maxComplexity: input.maxComplexity ?? "medium",
    costProfile: input.costProfile ?? null,
    stats: emptyStats(),
    active: true,
    notes: [],
    createdAt: now,
    updatedAt: now,
  });
}

export type AgentPatch = Partial<Pick<AgentDef, "name" | "fallbackSet" | "embeddingBaseUrl" | "systemPrompt" | "specialty" | "maxComplexity" | "active">>;

export async function updateAgent(id: string, patch: AgentPatch): Promise<AgentDef | null> {
  return agents.update(id, (agent) => {
    if (patch.fallbackSet !== undefined) assertFallbackSetAllowed(agent.role, patch.fallbackSet);
    Object.assign(agent, patch);
    agent.updatedAt = Date.now();
  });
}

/** The engineering manager's feedback loop: an appended note rather than a
 * rewritten prompt, so why an agent drifted to its current wording stays
 * readable and a bad tuning pass can be undone by dropping one line. */
export async function appendAgentNote(id: string, note: string): Promise<AgentDef | null> {
  return agents.update(id, (agent) => {
    agent.notes.push(note);
    agent.updatedAt = Date.now();
  });
}

export async function recordAssignment(id: string): Promise<void> {
  await agents.update(id, (agent) => {
    agent.stats.assigned += 1;
    agent.updatedAt = Date.now();
  });
}

export async function recordRunResult(id: string, outcome: { completed?: boolean; qaRejected?: boolean; costUsd?: number; runMs?: number }): Promise<void> {
  await agents.update(id, (agent) => {
    if (outcome.completed) agent.stats.completed += 1;
    if (outcome.qaRejected) agent.stats.qaRejections += 1;
    if (outcome.costUsd) agent.stats.totalCostUsd += outcome.costUsd;
    if (outcome.runMs) {
      // Rolling mean over completed runs; `completed` has already been
      // incremented above when this run finished one.
      const n = Math.max(1, agent.stats.completed);
      agent.stats.avgRunMs = agent.stats.avgRunMs + (outcome.runMs - agent.stats.avgRunMs) / n;
    }
    agent.updatedAt = Date.now();
  });
}

export async function deleteAgent(id: string): Promise<boolean> {
  return agents.remove(id);
}

export async function deleteProjectAgents(projectId: string): Promise<number> {
  return agents.removeWhere((row) => row.projectId === projectId);
}
