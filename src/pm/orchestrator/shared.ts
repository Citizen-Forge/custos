// Pure helpers shared across two or more dispatch stages. None of these
// touch Orchestrator instance state (the busy map, the timer) -- that's
// what stays behind in orchestrator.ts as the one genuinely stateful
// piece (guard()'s ownership of `busy`). Extracted verbatim out of the
// former Orchestrator class methods of the same name.
import * as board from "../board.js";
import { proposeFact } from "../facts.js";
import { isGitRepo, releaseWorkspace } from "../worktrees.js";
import type { Project } from "../../remote/projects.js";
import type { FactWrite } from "../contracts.js";
import type { AgentDef, ProjectSettings } from "../types.js";

/** Hard ceiling on concurrent engineers regardless of project settings --
 * every one is a live `claude` process with its own checkout, and a
 * mistyped setting shouldn't be able to fork-bomb the container. */
const ABSOLUTE_MAX_ENGINEERS = 12;

/** Fingerprints a set of work items so tickProject can tell "nothing has
 *  changed since the last pass" from "something's different, worth another
 *  look" without hand-tracking every kind of change (new item, edited
 *  title, a fresh comment, a status flip). `updatedAt` already advances on
 *  all of those; sorting by id makes the fingerprint order-independent, and
 *  a membership change (an item entering or leaving the set) changes the
 *  fingerprint on its own since the list of pairs is a different length. */
export function workItemsSignal(items: readonly { id: string; updatedAt: number }[]): string {
  return items
    .map((item) => `${item.id}:${item.updatedAt}`)
    .sort()
    .join(",");
}

/** How long assignReady's fingerprint gate (see ProjectSettings.lastAssignCheckedAt's
 *  doc comment) is allowed to suppress dispatch before tickProject forces
 *  another look regardless of whether the fingerprint changed. The
 *  fingerprint is a genuine fixed point when a ready ticket is blocked on
 *  something external (a PR merge, a credential fix) with no engineer
 *  in-flight to free a slot -- neither half of the fingerprint ever moves,
 *  so without this the EM would never be reconsidered again even after the
 *  real-world blocker resolves. One hour caps the wasted spend (at most one
 *  extra sizing pass per hour on a project that's genuinely stuck) against
 *  how long a resolved blocker can sit unnoticed. */
export const ASSIGN_STALE_RECHECK_MS = 60 * 60_000;

/** True once lastAssignCheckedAt is missing or older than the recheck
 *  window -- factored out from the tickProject gate so it's independently
 *  testable without spinning up a whole tick. */
export function isAssignCheckStale(lastAssignCheckedAt: number | null, now: number): boolean {
  return lastAssignCheckedAt === null || now - lastAssignCheckedAt >= ASSIGN_STALE_RECHECK_MS;
}

/** Same reasoning as ASSIGN_STALE_RECHECK_MS, for groomBacklog -- see
 *  ProjectSettings.lastGroomCheckedAt's doc comment. A groomed backlog
 *  ticket's blocker is routinely external (a dependency PR merging), so
 *  lastGroomSignal alone can become a fixed point long after the real
 *  blocker clears. One hour caps the wasted spend the same way it does
 *  for assign. */
export const GROOM_STALE_RECHECK_MS = 60 * 60_000;

/** True once lastGroomCheckedAt is missing or older than the recheck
 *  window -- mirrors isAssignCheckStale. */
export function isGroomCheckStale(lastGroomCheckedAt: number | null, now: number): boolean {
  return lastGroomCheckedAt === null || now - lastGroomCheckedAt >= GROOM_STALE_RECHECK_MS;
}

/**
 * How many engineers may run at once. Normally the project's own setting,
 * but a project that isn't a git repository has nothing to cut isolated
 * worktrees from, so its engineers would share one working copy and
 * overwrite each other -- those are clamped to one at a time.
 */
export async function engineerLimit(project: Project, settings: ProjectSettings): Promise<number> {
  const configured = Math.max(1, Math.min(settings.maxConcurrentEngineers ?? 1, ABSOLUTE_MAX_ENGINEERS));
  if (configured === 1) return 1;
  return (await isGitRepo(project.workspaceDir)) ? configured : 1;
}

/** Proposes any facts a run reported for curator review. Called after
 * every role's run, since any of them can learn something the next one
 * needs -- but none of them are trusted to put it straight in front of
 * every other agent unreviewed, same reasoning as the `record_fact`
 * tool's own `proposeFact` path (see mcp/pm-tools.ts). */
export async function applyFacts(projectId: string, agent: AgentDef, contract: { facts?: FactWrite[] } | null): Promise<void> {
  for (const fact of contract?.facts ?? []) {
    if (!fact.key?.trim() || !fact.value?.trim()) continue;
    await proposeFact({
      projectId,
      key: fact.key.trim(),
      value: fact.value.trim(),
      category: fact.category,
      writtenBy: agent.id,
      writtenByLabel: agent.name,
    });
  }
}

/**
 * The shared "a per-ticket dispatch failed" bookkeeping for
 * engineer/QA/devops/provisionRepo -- EXCEPT when the failure was
 * agent-runner.ts's AgentRunResult.unavailable (no provider in the
 * fallback chain was dispatchable, or the pre-spawn probe couldn't
 * reach one): that's not a fault of this ticket, nothing was actually
 * attempted, and every provider already has its own cooldown/circuit-
 * breaker. Piling board.recordAttemptFailure's separate, coarser
 * ticket-level backoff on top of that -- growing to a full hour at
 * RETRY_DELAYS_MS's ceiling -- meant three engineers sharing one
 * maxConcurrent:1 local slot could each serve up to an hour's penalty
 * for what amounts to "someone else had the slot for a few seconds".
 * Returns null when the caller should just return without touching
 * attempts/backoff/activity at all (the next ~20s tick retries for
 * free); otherwise the fresh attempt count for the caller's own
 * activity message.
 */
export async function handleDispatchFailure(workItemId: string, unavailable: boolean | undefined): Promise<number | null> {
  if (unavailable) return null;
  const backedOff = await board.recordAttemptFailure(workItemId);
  return backedOff?.attempts ?? 1;
}

/** Drops a ticket's checkout and forgets the path. Failures are swallowed:
 * a worktree that can't be removed is wasted disk, not a reason to fail
 * the transition that prompted it. */
export async function release(project: Project, workItemId: string): Promise<void> {
  try {
    await releaseWorkspace(project.workspaceDir, project.id, workItemId);
  } catch {
    // Best effort.
  }
  await board.updateWorkItem(workItemId, { worktreePath: null });
}
