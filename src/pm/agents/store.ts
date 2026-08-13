// The agents JsonCollection singleton and its read path: listing,
// lookup, display naming, and the backfill migrations that keep
// records written before a schema change readable. Every other
// agents/ sub-module imports the singleton from here rather than
// constructing its own, so there's exactly one JsonCollection backing
// agents.json.
import { JsonCollection, pmPath } from "../store.js";
import type { GatewayConfig } from "../../config.js";
import { pickPersonaName } from "../personas.js";
import type { AgentDef, AgentRole } from "../types.js";

export const agents = new JsonCollection<AgentDef>(pmPath("agents.json"));

export const emptyStats = (): AgentDef["stats"] => ({ assigned: 0, completed: 0, qaRejections: 0, totalCostUsd: 0, avgRunMs: 0 });

/** Records written before the project/global split never carried a `kind`
 * on disk; backfill it on read so callers always see one of the two values.
 * Default to "project" because every pre-split record IS a project agent. */
export function backfillKind(agent: AgentDef): AgentDef {
  return agent.kind ? agent : { ...agent, kind: "project" };
}

/** Agents created before personas existed have no human name; give them one
 * on read so the board doesn't show a mix of named and unnamed teammates. */
export async function backfillPersona(agent: AgentDef): Promise<AgentDef> {
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

/** The agent's "primary pick" — the provider/model that would be displayed
 *  as its current target, derived from its `fallbackSet` rather than stored
 *  on the agent. Centralises the contract `primary pick == fallbackSet[0]`
 *  into one helper so the operator-facing badge, the spend tracker, the
 *  EM's availability check, and any future consumers all agree on the same
 *  read. Returns null when:
 *    - the agent has no fallbackSet (legacy direct-pinned agent; should not
 *      exist post-migration)
 *    - the configured fallbackSet is missing or empty (orphan agent; the
 *      PM must be reset for the agent to recover)
 *  Callers handle the null by treating the agent as unusable rather than
 *  crashing — the runtime surfaces this as a 503 / orphan badge in the UI.
 *
 *  Reads config first because `pickPersonaName`-style call-site patterns
 *  like the orchestrator already pass `this.runtime.config` around. The
 *  helper is pure (no I/O), so it's safe to call per-row without batching. */
export interface PrimaryPick {
  providerKey: string;
  model: string;
}

export function primaryPick(agent: AgentDef, config: GatewayConfig): PrimaryPick | null {
  if (!agent.fallbackSet) return null;
  const set = config.fallbackSets?.[agent.fallbackSet];
  const first = set?.providers[0];
  if (!first) return null;
  return { providerKey: first.provider, model: first.model };
}
