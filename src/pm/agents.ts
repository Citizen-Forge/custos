import { JsonCollection, newId, pmPath } from "./store.js";
import type { GatewayConfig } from "../config.js";
import { ROLE_DEFAULT_FALLBACK_SET } from "./prompts.js";
import { pickPersonaName } from "./personas.js";
import type { AgentDef, AgentRole, Complexity, CostProfile } from "./types.js";

export const agents = new JsonCollection<AgentDef>(pmPath("agents.json"));

const emptyStats = (): AgentDef["stats"] => ({ assigned: 0, completed: 0, qaRejections: 0, totalCostUsd: 0, avgRunMs: 0 });

/** Records written before the project/global split never carried a `kind`
 * on disk; backfill it on read so callers always see one of the two values.
 * Default to "project" because every pre-split record IS a project agent. */
function backfillKind(agent: AgentDef): AgentDef {
  return agent.kind ? agent : { ...agent, kind: "project" };
}

/** Agents created before personas existed have no human name; give them one
 * on read so the board doesn't show a mix of named and unnamed teammates. */
async function backfillPersona(agent: AgentDef): Promise<AgentDef> {
  agent = backfillKind(agent);
  if (agent.personaName) return agent;
  const taken = (await agents.list()).map((row) => row.personaName).filter((name): name is string => !!name);
  const personaName = pickPersonaName(taken);
  return (await agents.update(agent.id, (row) => void (row.personaName = personaName))) ?? { ...agent, personaName };
}

export async function listAgents(projectId?: string): Promise<AgentDef[]> {
  // Board UX shows only project agents; global agents (memory curator,
  // permission classifier, embeddings) get their own panel in the admin UI
  // because the orchestrator doesn't assign them tickets. Mixing them
  // into the project's agent list would lead a project owner to suspect
  // the curator is "one of their engineers".
  const rows = (await agents.list()).filter((row) =>
    row.kind === "global" ? false : (!projectId || row.projectId === projectId || row.projectId === null),
  );
  const named: AgentDef[] = [];
  for (const row of rows) named.push(await backfillPersona(row));
  return named;
}

export async function getAgent(id: string): Promise<AgentDef | null> {
  const agent = await agents.get(id);
  return agent ? backfillPersona(agent) : null;
}

/** How an agent is referred to in comments, the activity feed and on cards:
 * the human name, with the role it plays. */
export function displayName(agent: AgentDef): string {
  return agent.personaName ? `${agent.personaName} (${agent.name})` : agent.name;
}

export async function findRoleAgent(projectId: string, role: AgentRole): Promise<AgentDef | null> {
  // Global agents carry a nominal role but never participate in project
  // assignment — exclude them so the engineering manager can't accidentally
  // pin tickets to the curator or the permission classifier.
  const rows = await agents.find((row) =>
    row.role === role && row.kind !== "global" && row.active && (row.projectId === projectId || row.projectId === null),
  );
  return rows[0] ?? null;
}

export async function listEngineers(projectId: string): Promise<AgentDef[]> {
  return agents.find((row) => row.role === "engineer" && row.active && row.projectId === projectId);
}

export interface CreateAgentInput {
  projectId: string | null;
  role: AgentRole;
  name: string;
  providerKey: string;
  model: string;
  systemPrompt?: string;
  specialty?: string | null;
  maxComplexity?: Complexity;
  createdBy?: AgentDef["createdBy"];
  personaName?: string;
  costProfile?: CostProfile | null;
  /** Fallback set name to use for dispatch. When set, the runtime iterates
   *  the fallback set's providers in order and uses the first available one.
   *  Overrides direct providerKey/model dispatch. */
  fallbackSet?: string;
  /** Pass "global" + `systemRole` for project-orthogonal services (memory
   *  curator, permission classifier, embeddings). Defaults to "project". */
  kind?: AgentDef["kind"];
  systemRole?: AgentDef["systemRole"];
}

export async function createAgent(input: CreateAgentInput): Promise<AgentDef> {
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
    providerKey: input.providerKey,
    model: input.model,
    fallbackSet: input.fallbackSet,
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

export type AgentPatch = Partial<Pick<AgentDef, "name" | "providerKey" | "model" | "fallbackSet" | "systemPrompt" | "specialty" | "maxComplexity" | "active">>;

export async function updateAgent(id: string, patch: AgentPatch): Promise<AgentDef | null> {
  return agents.update(id, (agent) => {
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

/** Provider/model combinations the engineering manager can pick from,
 * described in the terms it actually decides on: what it costs, whether
 * it's effectively free, and whether it's rate limited. Derived live from
 * gateway config so adding a provider in the admin UI immediately widens
 * the EM's menu without touching any agent record. */
export interface ProviderOption {
  providerKey: string;
  model: string;
  free: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  budgetUsd: number | null;
}

export function listProviderOptions(config: GatewayConfig): ProviderOption[] {
  const options: ProviderOption[] = [];
  // Anthropic is always offered: Custos authenticates it with the OAuth
  // subscription when no API key is set, so it carries no per-token cost
  // against the project budget and is what the EM should reach for on hard
  // tickets. Marked free for exactly that reason -- "free" here means "does
  // not draw down this project's metered spend," not "costs nobody money."
  const anthropicFree = !config.anthropic?.apiKey;
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
    options.push({ providerKey: "anthropic", model, free: anthropicFree, inputPerMTok: null, outputPerMTok: null, budgetUsd: null });
  }
  // Prefer the new providers shape with its model list.
  if (config.providers) {
    for (const [key, def] of Object.entries(config.providers)) {
      for (const modelDef of def.models) {
        if (!modelDef.enabled) continue;
        const pricing = modelDef.pricing;
        options.push({
          providerKey: key,
          model: modelDef.name,
          free: !pricing,
          inputPerMTok: pricing?.inputPerMillion ?? null,
          outputPerMTok: pricing?.outputPerMillion ?? null,
          budgetUsd: null, // Budget is now project-level, not provider-level.
        });
      }
    }
  }
  // Also read from the deprecated shape for backward compat.
  for (const [key, instance] of Object.entries(config.openaiCompatibleInstances)) {
    // Skip if already covered by the new providers shape (dedup by name).
    if (options.some((o) => o.providerKey === key)) continue;
    options.push({
      providerKey: key,
      model: instance.model,
      free: !instance.pricing,
      inputPerMTok: instance.pricing?.inputPerMillion ?? null,
      outputPerMTok: instance.pricing?.outputPerMillion ?? null,
      budgetUsd: null,
    });
  }
  return options;
}

/** Creates the built-in role agents a project needs to function the first
 * time it's opened. Idempotent -- only fills in roles that are missing, so
 * a hand-tuned product owner survives the next call. */
export async function ensureProjectAgents(projectId: string): Promise<AgentDef[]> {
  const created: AgentDef[] = [];
  const roles: Array<{ role: AgentRole; name: string; maxComplexity: Complexity }> = [
    { role: "steering", name: "Steering Co", maxComplexity: "high" },
    { role: "product-owner", name: "Product Owner", maxComplexity: "high" },
    { role: "engineering-manager", name: "Engineering Manager", maxComplexity: "high" },
    { role: "qa", name: "QA", maxComplexity: "high" },
    { role: "devops", name: "DevOps", maxComplexity: "high" },
    { role: "engineer", name: "Generalist Engineer", maxComplexity: "medium" },
    { role: "project-manager", name: "Project Manager", maxComplexity: "high" },
  ];
  for (const spec of roles) {
    const existing = await agents.find((row) => row.projectId === projectId && row.role === spec.role);
    if (existing.length) continue;
    const fallbackSet = ROLE_DEFAULT_FALLBACK_SET[spec.role];
    // Default providerKey/model from the fallback set's first entry.
    const providerKey = "anthropic";
    const model = "claude-sonnet-5";
    created.push(
      await createAgent({
        projectId,
        role: spec.role,
        name: spec.name,
        providerKey,
        model,
        fallbackSet,
        maxComplexity: spec.maxComplexity,
        createdBy: "system",
        specialty: spec.role === "engineer" ? "General-purpose implementation work across the stack" : null,
      }),
    );
  }
  return created;
}
