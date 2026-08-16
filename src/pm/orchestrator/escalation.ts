// Escalation stage: hands a ticket that's failed repeatedly to the
// project's Principal Engineer or Principal QA -- a deterministic
// reassignment, not something any LLM decides, because the whole point is
// a real invariant ("only after 5 failures, never for anything else")
// rather than a rule a prompt might not follow. See agents/bootstrap.ts
// for how the principal agents are seeded and agents/mutate.ts's
// assertFallbackSetAllowed for why nothing else can use their fallback
// set. escalateTicketManually is the human override of that same
// invariant -- an operator watching a ticket doesn't want to wait out
// the attempts ladder, so it reuses the identical reassignment logic
// without the threshold gate.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import { HUMAN_ASSIGNEE_ID } from "../types.js";
import type { AgentDef, WorkItem } from "../types.js";
import type { Orchestrator } from "../orchestrator.js";

/** Consecutive failed attempts, within the ticket's current stint in its
 *  column (board.ts resets this on every column change), before it's
 *  handed to the relevant principal agent instead of the regular roster.
 *  attempts=5 already means the ticket has burned through
 *  RETRY_DELAYS_MS's full backoff ladder at least once (~2.4h+ of
 *  real wall-clock retries) -- high enough that this fires on a
 *  genuinely wedged ticket, not a transient provider blip. */
const ESCALATION_THRESHOLD = 5;

export type EscalationResult = { ok: true; escalatedTo: string } | { ok: false; error: string };

/** Reassigns one in_progress ticket to `principal`, clears its attempt
 *  budget, and comments/emits activity. `reason` is the clause that
 *  follows "Escalated to <name> " -- e.g. "after 5+ consecutive failed
 *  attempts by X" for the automatic sweep, "by manual operator request"
 *  for the human override. */
async function escalateEngineerTicket(orch: Orchestrator, projectId: string, item: WorkItem, principal: AgentDef, reason: string): Promise<EscalationResult> {
  if (item.assigneeAgentId === principal.id) {
    return { ok: false, error: `Already escalated to ${agentStore.displayName(principal)}.` };
  }
  await board.updateWorkItem(item.id, { assigneeAgentId: principal.id });
  // Fresh attempt budget for the principal's own runs -- escalation is the
  // point at which we start counting again, not a debt the stronger model
  // inherits from the weaker one's failures.
  await board.clearAttempts(item.id);
  await board.addComment(
    item.id,
    "system",
    "Custos",
    `Escalated to ${agentStore.displayName(principal)} ${reason}. This run uses the "principal" fallback set (real Anthropic usage) -- see the ticket's comment history and prior PR for what's already been tried.`,
  );
  // No slackText/agent here -- this is the system reassigning work, not
  // the principal reporting on its own run (that comes from the engineer
  // stage once it actually dispatches), so first-person voice would be
  // backwards ("I've been escalated to myself").
  orch.emit("activity", projectId, { text: `Escalated "${item.title}" to ${agentStore.displayName(principal)} ${reason}` });
  return { ok: true, escalatedTo: agentStore.displayName(principal) };
}

/** Same shape as escalateEngineerTicket, but for a ticket in "qa" --
 *  targets WorkItem.qaAssigneeAgentId instead of assigneeAgentId, since
 *  QA has no per-ticket assignee the way engineer does (there's exactly
 *  one QA agent per project). */
async function escalateQaTicket(orch: Orchestrator, projectId: string, item: WorkItem, principalQa: AgentDef, reason: string): Promise<EscalationResult> {
  if (item.qaAssigneeAgentId === principalQa.id) {
    return { ok: false, error: `Already escalated to ${agentStore.displayName(principalQa)}.` };
  }
  await board.updateWorkItem(item.id, { qaAssigneeAgentId: principalQa.id });
  await board.clearAttempts(item.id);
  await board.addComment(
    item.id,
    "system",
    "Custos",
    `Escalated to ${agentStore.displayName(principalQa)} ${reason}. This run uses the "principal" fallback set (real Anthropic usage) -- see the ticket's comment history and prior PR for what's already been tried.`,
  );
  orch.emit("activity", projectId, { text: `Escalated "${item.title}" to ${agentStore.displayName(principalQa)} ${reason}` });
  return { ok: true, escalatedTo: agentStore.displayName(principalQa) };
}

/** Reassigns in_progress tickets stuck past ESCALATION_THRESHOLD to the
 *  project's principal agent, and qa tickets stuck past the same threshold
 *  to its Principal QA agent. A no-op once a ticket is already assigned to
 *  the relevant principal -- if it fails there too, there's nowhere higher
 *  to escalate, and it just keeps retrying with the model that's already
 *  the strongest one configured. */
export async function escalateStuckTickets(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`escalate:${projectId}`, projectId, async () => {
    // Don't rely on some OTHER stage (product-owner, EM, ...) having
    // already called resolveProjectAgent for this project this session --
    // a project with every autonomy toggle off except this one would
    // never get its principal agents seeded otherwise. Idempotent and
    // cheap (a no-op once every built-in role already exists), same as
    // every other stage's resolveProjectAgent call.
    await agentStore.ensureProjectAgents(projectId);
    const principal = await agentStore.findRoleAgent(projectId, "principal");
    const principalQa = await agentStore.findRoleAgent(projectId, "principal-qa");

    const items = await board.listWorkItems(projectId);

    if (principal) {
      const stuck = items.filter(
        (item) =>
          item.status === "in_progress" &&
          item.attempts >= ESCALATION_THRESHOLD &&
          item.assigneeAgentId &&
          item.assigneeAgentId !== HUMAN_ASSIGNEE_ID &&
          item.assigneeAgentId !== principal.id,
      );
      for (const item of stuck) {
        const previousAssignee = item.assigneeAgentId ? await agentStore.getAgent(item.assigneeAgentId) : null;
        await escalateEngineerTicket(orch, projectId, item, principal, `after ${ESCALATION_THRESHOLD}+ consecutive failed attempts by ${previousAssignee ? agentStore.displayName(previousAssignee) : "the previous assignee"}`);
      }
    }

    if (principalQa) {
      const stuckQa = items.filter(
        (item) => item.status === "qa" && item.attempts >= ESCALATION_THRESHOLD && item.qaAssigneeAgentId !== principalQa.id,
      );
      if (stuckQa.length) {
        const regularQa = await agentStore.findRoleAgent(projectId, "qa");
        for (const item of stuckQa) {
          await escalateQaTicket(orch, projectId, item, principalQa, `after ${ESCALATION_THRESHOLD}+ consecutive failed QA attempts by ${regularQa ? agentStore.displayName(regularQa) : "the regular QA agent"}`);
        }
      }
    }
  });
}

/** Human override of the same reassignment, triggered from the ticket
 *  detail UI's "Escalate" button -- an operator watching a ticket stall
 *  doesn't want to wait out the attempts ladder. Targets whichever
 *  principal fits the ticket's current column (in_progress -> Principal
 *  Engineer, qa -> Principal QA); any other column is rejected, since
 *  there's nothing to escalate to for backlog/ready/complete work.
 *  Shares the same `escalate:${projectId}` guard key as the automatic
 *  sweep so the two can't race each other's reassignment of the same
 *  ticket -- returns a clear "try again" error rather than a silent
 *  no-op if the sweep happens to be running at that exact moment. */
export async function escalateTicketManually(orch: Orchestrator, projectId: string, workItemId: string): Promise<EscalationResult> {
  const result = await orch.guard(`escalate:${projectId}`, projectId, async (): Promise<EscalationResult> => {
    await agentStore.ensureProjectAgents(projectId);
    const item = await board.getWorkItem(workItemId);
    if (!item || item.projectId !== projectId) return { ok: false, error: "Ticket not found." };

    if (item.status === "in_progress") {
      const principal = await agentStore.findRoleAgent(projectId, "principal");
      if (!principal) return { ok: false, error: "No Principal Engineer agent is configured for this project." };
      return escalateEngineerTicket(orch, projectId, item, principal, "by manual operator request");
    }
    if (item.status === "qa") {
      const principalQa = await agentStore.findRoleAgent(projectId, "principal-qa");
      if (!principalQa) return { ok: false, error: "No Principal QA agent is configured for this project." };
      return escalateQaTicket(orch, projectId, item, principalQa, "by manual operator request");
    }
    return { ok: false, error: `Tickets in "${item.status}" cannot be escalated -- only in_progress or qa can be.` };
  });
  return result ?? { ok: false, error: "Escalation is already running for this project -- try again in a moment." };
}
