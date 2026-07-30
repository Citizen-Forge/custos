import { JsonCollection, newId, pmPath } from "./store.js";
import type { GatewayConfig } from "../config.js";
import { GLOBAL_AGENT_FALLBACK_SET, ROLE_DEFAULT_FALLBACK_SET } from "./prompts.js";
import { pickPersonaName } from "./personas.js";
import { getSettings as pmGetSettings, updateSettings as pmUpdateSettings } from "./project-settings.js";
import type { AgentDef, AgentRole, Complexity, CostProfile, GlobalSystemRole } from "./types.js";

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

/**
 * Migrate every project and global agent to the canonical fallback-set
 * shape:
 *
 *   - **Assign fallbackSet.** Agents missing one get the role-appropriate
 *     default from ROLE_DEFAULT_FALLBACK_SET (project roles) or
 *     GLOBAL_AGENT_FALLBACK_SET (global system roles). Projects whose
 *     agents received a new fallbackSet get `pmConfigured` reset so the
 *     Project Manager re-evaluates against the current provider config.
 *
 *   - **Orphan handling.** Agents whose configured fallbackSet no longer
 *     exists (the user deleted the set) or has an empty providers array
 *     get their `fallbackSet` CLEARED so the next PM run has a clean
 *     slate and the runtime doesn't dispatch to a non-existent set. The
 *     project's pmConfigured is reset for the same reason.
 *
 * The contract is `primary pick == fallbackSet[0]` — derived on read via
 * `primaryPick(agent, config)`, never stored on the agent. Old agents.json
 * records written before this commit still carry `providerKey`/`model`
 * fields on disk; the JSON collection parses them as inert extras, but
 * no runtime read accesses them after this point (the helper is the only
 * source of truth). A future cleanup pass can prune the on-disk ghosts
 * without code changes; today they're harmless trailing data.
 *
 * Safe to call on every startup: agents already matching the contract
 * are skipped (no-op). Returns the number of agents actually written.
 */
export async function migrateToFallbackSets(config: GatewayConfig): Promise<number> {
  const allAgents = await agents.list();
  const projectIds = new Set<string>();
  let migrated = 0;
  const fallbackSets = config.fallbackSets ?? {};

  for (const agent of allAgents) {
    const updates: Partial<AgentDef> = {};
    let fallbackSetChanged = false;
    let orphanCleared = false;

    if (!agent.fallbackSet) {
      // Project role defaults live in ROLE_DEFAULT_FALLBACK_SET; global
      // system roles use GLOBAL_AGENT_FALLBACK_SET (which keys by
      // systemRole rather than role, since the solver needs the host
      // service identity to pick a model shape -- e.g. embeddings wants
      // a set whose first entry is an embedding-capable provider).
      const isGlobal = agent.kind === "global";
      const fb = isGlobal
        ? agent.systemRole ? GLOBAL_AGENT_FALLBACK_SET[agent.systemRole] : undefined
        : ROLE_DEFAULT_FALLBACK_SET[agent.role];
      if (fb) {
        updates.fallbackSet = fb;
        fallbackSetChanged = true;
      }
    } else {
      // The agent already names a set; check it's still valid. A set with
      // zero providers or one that's been deleted from config means any
      // dispatch against this agent is doomed. Clear the field so the
      // re-assignment pass below can pick a valid one.
      const setDef = fallbackSets[agent.fallbackSet];
      if (!setDef || setDef.providers.length === 0) {
        updates.fallbackSet = undefined;
        orphanCleared = true;
      }
    }

    if (Object.keys(updates).length === 0) continue;

    await agents.update(agent.id, (row) => {
      Object.assign(row, updates);
      row.updatedAt = Date.now();
    });
    migrated++;
    if (agent.projectId && (fallbackSetChanged || orphanCleared)) projectIds.add(agent.projectId);
  }

  // Reset pmConfigured for every project whose agents were touched -- a
  // falling-back-onto-default assignment means the PM should re-evaluate
  // against current provider config rather than keep whatever fallback
  // set it picked before the change.
  if (projectIds.size > 0) {
    for (const pid of projectIds) {
      const settings = await pmGetSettings(pid);
      if (settings.pmConfigured) {
        await pmUpdateSettings(pid, { pmConfigured: false, pmLastRunAt: null });
      }
    }
  }

  return migrated;
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
  for (const [key, instance] of Object.entries(config.openaiCompatibleInstances ?? {})) {
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
    created.push(
      await createAgent({
        projectId,
        role: spec.role,
        name: spec.name,
        fallbackSet: ROLE_DEFAULT_FALLBACK_SET[spec.role],
        maxComplexity: spec.maxComplexity,
        createdBy: "system",
        specialty: spec.role === "engineer" ? "General-purpose implementation work across the stack" : null,
      }),
    );
  }
  return created;
}

/** The fallback set each global system role should default to when seeded.
 * Used by `migrateToFallbackSets` to assign a set on first boot and by
 * `ensureGlobalAgents` when creating a fresh global row. Optional per
 * role -- a global service without a default is left with `fallbackSet`
 * unset (and the runtime treats that as "not yet configured"). */
export function defaultFallbackSetForGlobal(role: GlobalSystemRole): string | undefined {
  return GLOBAL_AGENT_FALLBACK_SET[role];
}
