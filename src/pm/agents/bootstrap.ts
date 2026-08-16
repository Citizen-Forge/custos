// Seeds the built-in role agents a project or global service needs on
// first use.
import { GLOBAL_AGENT_FALLBACK_SET, ROLE_DEFAULT_FALLBACK_SET } from "../prompts.js";
import type { AgentDef, AgentRole, Complexity, GlobalSystemRole } from "../types.js";
import { agents } from "./store.js";
import { createAgent } from "./mutate.js";

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
    // Escalation-only: see orchestrator/escalation.ts. Never picked by the
    // engineering manager's normal ready-ticket assignment (it's excluded
    // from listEngineers()'s roster) -- only the escalation stage ever
    // sets a ticket's assigneeAgentId to this one, and only after 5
    // consecutive failed attempts.
    { role: "principal", name: "Principal Engineer", maxComplexity: "high" },
    // Same escalation-only shape as "principal" above, but for tickets
    // stuck in "qa" instead of "in_progress" -- see escalateStuckTickets'
    // QA branch. Never picked for a ticket's regular per-project QA agent
    // (resolveProjectAgent(projectId, "qa") only ever returns the "qa"
    // role); only set via WorkItem.qaAssigneeAgentId, and only after 5
    // consecutive failed QA attempts.
    { role: "principal-qa", name: "Principal QA", maxComplexity: "high" },
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
