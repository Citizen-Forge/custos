import { JsonCollection, newId, pmPath } from "./store.js";
import type { GatewayConfig } from "../config.js";
import { ROLE_DEFAULT_MODEL } from "./prompts.js";
import { pickPersonaName } from "./personas.js";
import type { AgentDef, AgentRole, Complexity, CostProfile } from "./types.js";

const agents = new JsonCollection<AgentDef>(pmPath("agents.json"));

const emptyStats = (): AgentDef["stats"] => ({ assigned: 0, completed: 0, qaRejections: 0, totalCostUsd: 0, avgRunMs: 0 });

/** Agents created before personas existed have no human name; give them one
 * on read so the board doesn't show a mix of named and unnamed teammates. */
async function backfillPersona(agent: AgentDef): Promise<AgentDef> {
  if (agent.personaName) return agent;
  const taken = (await agents.list()).map((row) => row.personaName).filter((name): name is string => !!name);
  const personaName = pickPersonaName(taken);
  return (await agents.update(agent.id, (row) => void (row.personaName = personaName))) ?? { ...agent, personaName };
}

export async function listAgents(projectId?: string): Promise<AgentDef[]> {
  const rows = (await agents.list()).filter((row) => !projectId || row.projectId === projectId || row.projectId === null);
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
  const rows = await agents.find((row) => row.role === role && row.active && (row.projectId === projectId || row.projectId === null));
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
}

export async function createAgent(input: CreateAgentInput): Promise<AgentDef> {
  const now = Date.now();
  const taken = (await agents.list()).map((agent) => agent.personaName).filter((name): name is string => !!name);
  return agents.insert({
    id: newId(),
    projectId: input.projectId,
    role: input.role,
    name: input.name,
    personaName: input.personaName ?? pickPersonaName(taken),
    providerKey: input.providerKey,
    model: input.model,
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

export type AgentPatch = Partial<Pick<AgentDef, "name" | "providerKey" | "model" | "systemPrompt" | "specialty" | "maxComplexity" | "active">>;

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
  for (const [key, instance] of Object.entries(config.openaiCompatibleInstances)) {
    options.push({
      providerKey: key,
      model: instance.model,
      free: !instance.pricing,
      inputPerMTok: instance.pricing?.inputPerMillion ?? null,
      outputPerMTok: instance.pricing?.outputPerMillion ?? null,
      budgetUsd: instance.budget?.limitUsd ?? null,
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
  ];
  for (const spec of roles) {
    const existing = await agents.find((row) => row.projectId === projectId && row.role === spec.role);
    if (existing.length) continue;
    const [providerKey, model] = ROLE_DEFAULT_MODEL[spec.role];
    created.push(
      await createAgent({
        projectId,
        role: spec.role,
        name: spec.name,
        providerKey,
        model,
        maxComplexity: spec.maxComplexity,
        createdBy: "system",
        specialty: spec.role === "engineer" ? "General-purpose implementation work across the stack" : null,
      }),
    );
  }
  return created;
}
