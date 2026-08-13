// One-time-per-record migration to the canonical fallback-set shape.
// Self-contained: only touches the agents collection and project
// settings, so it can run standalone on every startup.
import type { GatewayConfig } from "../../config.js";
import { GLOBAL_AGENT_FALLBACK_SET, ROLE_DEFAULT_FALLBACK_SET } from "../prompts.js";
import { getSettings as pmGetSettings, updateSettings as pmUpdateSettings } from "../project-settings.js";
import type { AgentDef } from "../types.js";
import { agents } from "./store.js";

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
