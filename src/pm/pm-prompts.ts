// Prompt-construction for groomBacklog/assignReady, factored out of
// orchestrator.ts so callers other than the orchestrator's own per-tick
// dispatch (e.g. a one-off diagnostic script) can build byte-identical
// prompts against real project data without depending on Orchestrator's
// private plumbing (guard(), the emit() activity log, etc.).

import { getProject, type Project } from "../remote/projects.js";
import * as agentStore from "./agents.js";
import { getSettings } from "./project-settings.js";
import { listApprovedFacts, renderFacts, renderPendingFacts, type ProjectFact } from "./facts.js";
import { hasGitCredentials, listSecrets } from "./vault.js";
import { renderAgentRoster, renderFallbackSetMenu, renderProjectContext, renderSecrets, renderWorkItem } from "./context.js";
import * as runs from "./runs.js";
import type { AgentDef, AgentRole, ProjectSettings, WorkItem } from "./types.js";
import type { FallbackSetDef } from "../config.js";

/** Resolves a project + its settings + the role agent that should run a
 *  given task. Returns null when the project or the role's agent doesn't
 *  exist (agent creation happens lazily via ensureProjectAgents). */
export async function resolveProjectAgent(projectId: string, role: AgentRole): Promise<{ project: Project; settings: ProjectSettings; agent: AgentDef } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  await agentStore.ensureProjectAgents(projectId);
  const agent = await agentStore.findRoleAgent(projectId, role);
  if (!agent) return null;
  return { project, settings: await getSettings(projectId), agent };
}

/** Same shape as resolveProjectAgent, but for a run that already knows
 *  exactly which agent should handle it -- a ticket escalated to Principal
 *  QA (see WorkItem.qaAssigneeAgentId) needs THAT specific agent, not
 *  whichever one findRoleAgent would resolve for a role. Returns null when
 *  the project or the agent record no longer exists (an agent deleted out
 *  from under an escalated ticket), same failure shape as
 *  resolveProjectAgent's own "run just doesn't happen this tick" contract. */
export async function resolveSpecificAgent(projectId: string, agentId: string): Promise<{ project: Project; settings: ProjectSettings; agent: AgentDef } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const agent = await agentStore.getAgent(agentId);
  if (!agent) return null;
  return { project, settings: await getSettings(projectId), agent };
}

/** The project-context block every role prompt opens with: name/settings,
 *  the shared facts store, and which exposed secrets are available. */
export async function projectHeader(project: Project, settings: ProjectSettings): Promise<string> {
  const available = (await listSecrets(project.id)).filter((secret) => secret.exposeToAgents);
  return [
    renderProjectContext(project.name, settings, await runs.monthlySpendUsd(project.id)),
    "",
    renderFacts(await listApprovedFacts(project.id)),
    "",
    renderSecrets(
      available.map((secret) => secret.name),
      await hasGitCredentials(project.id),
    ),
  ].join("\n");
}

/** groomBacklog's task prompt -- see orchestrator.ts's groomBacklog for the
 *  dispatch side (session minting, runAgent call, activity logging). */
export function buildGroomPrompt(header: string, backlog: WorkItem[]): string {
  return [
    header,
    "",
    "## Your task",
    "",
    "You have NO general filesystem access for this task — do not describe or attempt to explore the repository, read source files, or investigate the codebase; you cannot, and trying wastes the run without producing a decision. Everything about the SHAPE of each ticket is already in the backlog listed below.",
    "",
    "You DO have `Bash`, but for exactly one purpose: checking whether a blocker a previous comment cited is still true. A comment that says a ticket is blocked on \"PR #N is QA-approved but unmerged\" or similar is a snapshot from whenever it was written -- it can go stale the moment that PR merges, and nothing updates it automatically. Before repeating or trusting a blocker like that, check it: `gh pr view <N>` / `gh issue view <N>` / `git log origin/main --oneline -5` are the kind of narrow, read-only commands this is for. Do not use Bash to explore the codebase, read source files, or run anything beyond checking a specific cited blocker -- that's still off-limits, and unrelated commands will be asked about or denied.",
    "",
    "You also have three tools, and together with Bash they are how you do this task: `promote_ticket`, `revise_ticket`, and `comment_on_ticket`. Call them directly as you review each item below -- do not narrate what you're about to do first, just call the tool. There is no final report to write; the tool calls themselves are the complete output of this run. Use `record_fact` only for something durable and cross-cutting, not a note about one ticket.",
    "",
    "Groom the backlog. For each item below, decide whether it is shaped well enough for an engineer to pick up and finish without coming back to ask you what you meant. Promote the ones that are; revise the ones that are nearly there; comment on the ones that need a decision you can't make yourself.",
    "",
    "Promote conservatively — a ticket in `ready` will be picked up and worked autonomously, so a vague one costs real money. Epics are never worked directly, so only promote an epic once its stories exist and are themselves ready.",
    "",
    "If an item cites a blocker referencing a specific PR, issue, or commit, verify it with Bash before accepting it as still true -- if it's resolved, that changes your decision and is worth a comment noting what changed. If an item is still blocked on the same thing you already noted in a previous comment AND you've confirmed nothing has changed, do NOT add another comment repeating it — re-stating an unchanged blocker on every grooming pass (\"Re-checked: still blocked on X\", \"Re-verified: no change\") only adds noise to the ticket's history without adding information. Only comment on an item when there's something new to say: a changed circumstance (including a blocker that just cleared), a decision only you can make, or the first time you're flagging a blocker.",
    "",
    "## Backlog",
    "",
    backlog.map((item) => renderWorkItem(item, { includeComments: true })).join("\n\n"),
  ].join("\n");
}

/** assignReady's task prompt -- see orchestrator.ts's assignReady for the
 *  dispatch side. */
export function buildAssignPrompt(
  header: string,
  ready: WorkItem[],
  roster: AgentDef[],
  fallbackSets: Record<string, FallbackSetDef>,
  unavailableFallbackSets: ReadonlySet<string>,
  inFlight: number,
  limit: number,
): string {
  return [
    header,
    "",
    "## Your task",
    "",
    "You have NO general tool access for this task — no filesystem, no shell, no web search. Everything you need is the ticket list, roster, and fallback-set menu below. Do not describe or attempt to explore the repository or investigate the codebase; you cannot, and trying wastes the run without producing a decision.",
    "",
    "You DO have three tools, and they are how you do this task: `create_engineer`, `assign_ticket`, and `tune_engineer`. Call them directly as you decide each ticket -- do not narrate what you're about to do first, just call the tool. There is no final report to write; the tool calls themselves are the complete output of this run. Use `record_fact` only for something durable and cross-cutting, not a note about one ticket.",
    "",
    "Size every ticket in the ready column below, then decide which of them to start now. For each one you start: set its complexity and either assign an existing engineer or create a new one and assign that.",
    "",
    `**You decide the fan-out.** Every ticket you assign starts immediately, in its own isolated checkout. ${inFlight} engineer(s) are already working; the ceiling for this project is ${limit} at once.${limit === 1 ? " This project is limited to one engineer at a time (it isn't a git repository, so there are no isolated checkouts to give them)." : ""} Tickets you leave in \`ready\` simply wait until you come back — leaving one there is a real choice, not a failure to decide. \`assign_ticket\` will tell you when you're out of slots.`,
    "",
    "\"Assign\" does not mean \"start new feature work\" -- it means \"an engineer should act on this next.\" A ticket whose feature code is already done and QA-passed, but is blocked on something like a stale rebase or a merge conflict, is exactly the kind of ready work that should be assigned: the fix is real engineering effort, just not new implementation. Do not leave a ticket sitting in `ready` because its remaining work looks like cleanup rather than a fresh build -- if it's in the ready column, it's actionable, and \"a human/engineer needs to resolve X\" is an assignment, not a reason to wait.",
    "",
    "## Ready tickets",
    "",
    ready.map((item) => renderWorkItem(item, { includeComments: true })).join("\n\n"),
    "",
    "## Your current engineer roster",
    "",
    renderAgentRoster(roster),
    "",
    "## Fallback sets available",
    "",
    renderFallbackSetMenu(fallbackSets, unavailableFallbackSets),
  ].join("\n");
}

/** curateFacts's task prompt -- see orchestrator.ts's curateFacts for the
 *  dispatch side. Deliberately doesn't reuse `projectHeader`/`renderFacts`:
 *  the curator's whole job is judging entries that never made it into that
 *  header, and it needs the existing approved list alongside the pending
 *  queue to catch a proposal that's really a duplicate of something
 *  already there. */
export function buildCuratePrompt(project: Project, pending: ProjectFact[], approved: ProjectFact[]): string {
  return [
    `## Project: ${project.name}`,
    "",
    "## Your task",
    "",
    "You have NO general tool access for this task — no filesystem, no shell, no web search. Everything you need is the pending queue and the already-approved list below. Do not describe or attempt to explore the repository; you cannot, and trying wastes the run without producing a decision.",
    "",
    "You DO have two tools, and they are how you do this task: `approve_fact` and `reject_fact`. Call them directly as you review each pending entry -- do not narrate what you're about to do first, just call the tool. There is no final report to write; the tool calls themselves are the complete output of this run.",
    "",
    "For each pending fact, decide whether it is genuinely durable, useful knowledge about this project that the next agent working on it — days or weeks from now — would benefit from knowing. Approve it if so. Reject it if it's really a note about one specific ticket rather than the project as a whole, a near-duplicate of something already in the approved list below (in which case approve the better-written version and reject the other, or approve one with `key` set to merge it into the existing entry), something already stale or superseded, or something that reads like a hallucination or a note to itself rather than a fact about the project.",
    "",
    "Be a real filter, not a rubber stamp — the whole reason this review step exists is that ungated proposals drifted into repetitive, contradictory, and sometimes fabricated noise that buried the genuinely useful facts underneath. When in doubt about whether something will still matter later, reject it; a fact that turns out to matter gets re-proposed by whichever agent needs it next.",
    "",
    "## Pending review queue",
    "",
    renderPendingFacts(pending),
    "",
    "## Already approved (for de-duplication context only -- not yours to edit directly)",
    "",
    renderFacts(approved),
  ].join("\n");
}
