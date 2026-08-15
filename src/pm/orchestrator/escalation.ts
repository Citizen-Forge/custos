// Escalation stage: hands a ticket that's failed repeatedly to the
// project's Principal Engineer -- a deterministic reassignment, not
// something any LLM decides, because the whole point is a real invariant
// ("only after 5 failures, never for anything else") rather than a rule
// a prompt might not follow. See agents/bootstrap.ts for how the
// principal agent is seeded and agents/mutate.ts's
// assertFallbackSetAllowed for why nothing else can use its fallback set.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import { HUMAN_ASSIGNEE_ID } from "../types.js";
import type { Orchestrator } from "../orchestrator.js";

/** Consecutive failed attempts, within the ticket's current in_progress
 *  stint (board.ts resets this on every column change), before it's
 *  handed to the Principal Engineer instead of the regular engineer
 *  roster. attempts=5 already means the ticket has burned through
 *  RETRY_DELAYS_MS's full backoff ladder at least once (~2.4h+ of
 *  real wall-clock retries) -- high enough that this fires on a
 *  genuinely wedged ticket, not a transient provider blip. */
const ESCALATION_THRESHOLD = 5;

/** Reassigns in_progress tickets stuck past ESCALATION_THRESHOLD to the
 *  project's principal agent. A no-op once a ticket is already assigned
 *  to the principal -- if it fails there too, there's nowhere higher to
 *  escalate, and it just keeps retrying with the model that's already
 *  the strongest one configured. */
export async function escalateStuckTickets(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`escalate:${projectId}`, projectId, async () => {
    // Don't rely on some OTHER stage (product-owner, EM, ...) having
    // already called resolveProjectAgent for this project this session --
    // a project with every autonomy toggle off except this one would
    // never get its principal agent seeded otherwise. Idempotent and
    // cheap (a no-op once every built-in role already exists), same as
    // every other stage's resolveProjectAgent call.
    await agentStore.ensureProjectAgents(projectId);
    const principal = await agentStore.findRoleAgent(projectId, "principal");
    if (!principal) return;

    const stuck = (await board.listWorkItems(projectId)).filter(
      (item) =>
        item.status === "in_progress" &&
        item.attempts >= ESCALATION_THRESHOLD &&
        item.assigneeAgentId &&
        item.assigneeAgentId !== HUMAN_ASSIGNEE_ID &&
        item.assigneeAgentId !== principal.id,
    );
    if (!stuck.length) return;

    for (const item of stuck) {
      const previousAssignee = item.assigneeAgentId ? await agentStore.getAgent(item.assigneeAgentId) : null;
      await board.updateWorkItem(item.id, { assigneeAgentId: principal.id });
      // Fresh attempt budget for the principal's own runs -- escalation
      // is the point at which we start counting again, not a debt the
      // stronger model inherits from the weaker one's failures.
      await board.clearAttempts(item.id);
      await board.addComment(
        item.id,
        "system",
        "Custos",
        `Escalated to ${agentStore.displayName(principal)} after ${ESCALATION_THRESHOLD}+ consecutive failed attempts by ${previousAssignee ? agentStore.displayName(previousAssignee) : "the previous assignee"}. This run uses the "principal" fallback set (real Anthropic usage) -- see the ticket's comment history and prior PR for what's already been tried.`,
      );
      orch.emit("activity", projectId, `Escalated "${item.title}" to ${agentStore.displayName(principal)} after ${ESCALATION_THRESHOLD}+ failed attempts`);
    }
  });
}
