import type { AgentDef, Idea, ProjectSettings, WorkItem } from "./types.js";
import type { GatewayConfig } from "../config.js";

/**
 * Render the "runs on" line for an engineer roster row. Reads from the
 *  agent's fallbackSet rather than its (now-dropped) `providerKey`/`model`
 *  fields; the operator-facing primary pick is `fallbackSet[0]`, with
 *  `+N` when the chain has more than one entry, exactly as the
 *  AgentModelSelect label. Config is passed in (rather than read from a
 *  module-level singleton) so tests can render rosters against a fixed
 *  GatewayConfig without bootstrapping the full runtime.
 */
export function describeAgentPick(agent: AgentDef, config: GatewayConfig): string {
  const set = agent.fallbackSet ? config.fallbackSets?.[agent.fallbackSet] : null;
  if (!set || set.providers.length === 0) return "no fallback set";
  const first = set.providers[0];
  if (set.providers.length === 1) return `${first.provider} / ${first.model}`;
  return `${first.provider} / ${first.model} +${set.providers.length - 1}`;
}

/** Renders board state as markdown for an agent prompt. Kept in one place
 * so every role sees a ticket described the same way -- a QA agent and the
 * engineer whose work it's judging must be reading the same fields. */

/** Hard caps on how many comments/history entries `renderWorkItem` embeds
 *  into an agent prompt. Without this, a ticket that cycles through many
 *  failed automated attempts -- each attempt's failure logged as a new
 *  comment via `board.addComment` -- grows its comment list without bound,
 *  and every future render re-embeds the *entire* history, including all
 *  the past failure comments. Once that pushes a spawned `claude -p`
 *  subprocess's combined argv+environ past the OS's ARG_MAX, every
 *  subsequent attempt fails at spawn time (`E2BIG`) before it can even
 *  reach a provider -- which itself gets logged as another failure
 *  comment, guaranteeing the ticket can never recover. Observed live on
 *  two pre-PR-enforcement tickets that had independently reached 4,447
 *  and 4,508 comments (~230KB each) purely from repeated QA-attempt
 *  failure logging. Capped to the most recent entries -- exactly the ones
 *  relevant to "what's the current state of this ticket" -- rather than
 *  every entry ever recorded. */
const MAX_RENDERED_COMMENTS = 30;
const MAX_RENDERED_HISTORY = 20;

export function renderWorkItem(item: WorkItem, opts: { includeComments?: boolean; includeHistory?: boolean } = {}): string {
  const lines = [
    `### ${item.type.toUpperCase()} ${item.id} — ${item.title}`,
    `Status: ${item.status}${item.complexity ? ` · complexity: ${item.complexity}` : ""}${item.qaRounds ? ` · bounced by QA ${item.qaRounds}x` : ""}`,
  ];
  if (item.labels.length) lines.push(`Labels: ${item.labels.join(", ")}`);
  // Branch/PR are only genuinely "this is active work" signals while the
  // ticket is actually in in_progress/qa/complete. A ticket QA bounced
  // back to ready (or, rarer, all the way to backlog) keeps its old
  // branch/prUrl on the row -- shown unconditionally, that read exactly
  // like still-active work sitting right under a "Status: ready" line,
  // which is misleading at best. Observed live: an engineering manager
  // reading a bounced-back ready ticket with a Branch + Pull request line
  // attached repeatedly failed to assign it, once claiming the board
  // showed nothing in "ready" at all -- the stale in-progress-shaped
  // fields are the likeliest reason a small model read it as already
  // spoken for. Still surfaced, just reframed so "there's a branch to
  // reuse" doesn't read as "this is taken."
  const isActiveStatus = item.status === "in_progress" || item.status === "qa" || item.status === "complete";
  if (isActiveStatus) {
    if (item.branch) lines.push(`Branch: ${item.branch}`);
    if (item.prUrl) lines.push(`Pull request: ${item.prUrl}`);
  } else if (item.branch || item.prUrl) {
    lines.push(`Previous attempt (bounced back to ${item.status}): branch \`${item.branch ?? "?"}\`${item.prUrl ? `, PR ${item.prUrl}` : ""} -- reuse or restart as appropriate.`);
  }
  if (item.description.trim()) lines.push("", item.description.trim());
  if (item.acceptanceCriteria.length) {
    lines.push("", "**Acceptance criteria**", ...item.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (item.subtasks.length) {
    lines.push("", "**Subtasks**", ...item.subtasks.map((s) => `- [${s.done ? "x" : " "}] ${s.title}`));
  }
  if (opts.includeComments && item.comments.length) {
    const shown = item.comments.slice(-MAX_RENDERED_COMMENTS);
    const omitted = item.comments.length - shown.length;
    lines.push(
      "",
      omitted > 0 ? `**Comments** (showing the most recent ${shown.length} of ${item.comments.length} — ${omitted} earlier omitted)` : "**Comments**",
      ...shown.map((c) => `- **${c.authorLabel}**: ${c.body}`),
    );
  }
  if (opts.includeHistory && item.history.length) {
    const shown = item.history.slice(-MAX_RENDERED_HISTORY);
    const omitted = item.history.length - shown.length;
    lines.push(
      "",
      omitted > 0 ? `**History** (showing the most recent ${shown.length} of ${item.history.length} — ${omitted} earlier omitted)` : "**History**",
      ...shown.map((h) => `- ${new Date(h.at).toISOString()} ${h.actor}: ${h.from ?? "—"} → ${h.to}${h.note ? ` (${h.note})` : ""}`),
    );
  }
  return lines.join("\n");
}

export function renderIdea(idea: Idea): string {
  return [`### ${idea.title}`, "", idea.brief.trim()].join("\n");
}

export function renderBoardSummary(items: WorkItem[]): string {
  if (!items.length) return "_The board is empty._";
  const byStatus = new Map<string, WorkItem[]>();
  for (const item of items) {
    const list = byStatus.get(item.status) ?? [];
    list.push(item);
    byStatus.set(item.status, list);
  }
  const lines: string[] = [];
  for (const [status, list] of byStatus) {
    lines.push(`**${status}** (${list.length})`);
    for (const item of list) lines.push(`- \`${item.id}\` [${item.type}] ${item.title}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderAgentRoster(roster: AgentDef[], config?: GatewayConfig): string {
  if (!roster.length) return "_No engineer agents exist yet — you will need to create at least one._";
  // The roster call site in orchestrator.ts passes `this.runtime.config`;
  // tests and any future caller that omit the config still get a sane
  // string ("no fallback set") rather than crashing.
  const cfg = config ?? ({} as GatewayConfig);
  return roster
    .map((agent) => {
      const s = agent.stats;
      const bounceRate = s.completed ? `${Math.round((s.qaRejections / s.completed) * 100)}%` : "n/a";
      return [
        `### \`${agent.id}\` — ${agent.name}`,
        `Runs on: ${describeAgentPick(agent, cfg)} · rated up to **${agent.maxComplexity}** complexity`,
        `Specialty: ${agent.specialty ?? "unspecified"}`,
        `Record: ${s.assigned} assigned, ${s.completed} completed, ${s.qaRejections} QA bounces (${bounceRate} of completed), $${s.totalCostUsd.toFixed(2)} spent, ${Math.round(s.avgRunMs / 1000)}s average run`,
        agent.notes.length ? `Existing tuning notes:\n${agent.notes.map((n) => `  - ${n}`).join("\n")}` : "No tuning notes yet.",
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * The menu the engineering manager actually decides from: which named
 * fallback set to put a new engineer on. Replaces the old per-model menu
 * (every enabled model across every configured provider, individually
 * scored) -- an engineer is assigned a fallback SET, never a raw model, so
 * that was never actually the right unit of information to show, and on a
 * live project with a fully-scanned OpenRouter/Gemini/OpenAI catalog it
 * meant dumping 600+ model rows into every assignReady prompt. Observed
 * live: every model tested against that version of the prompt got
 * derailed into discussing "model selection" instead of sizing and
 * assigning the actual ticket -- the real task was buried under the
 * catalog. Exhausted sets are listed rather than hidden, same reasoning
 * as before: the manager needs to know a set exists and is temporarily
 * unusable so it can route around it deliberately.
 */
export function renderFallbackSetMenu(sets: Record<string, { name: string; description: string }>, unavailableSetNames: ReadonlySet<string>): string {
  const entries = Object.entries(sets);
  if (!entries.length) return "_No fallback sets are configured._";
  const lines: string[] = [];
  for (const [key, set] of entries) {
    const status = unavailableSetNames.has(key) ? "**EXHAUSTED right now**" : "**available**";
    lines.push(`- \`${key}\` (${set.name}) — ${set.description} · ${status}`);
  }
  lines.push(
    "",
    "**Never assign work to an exhausted set** — the run will fail immediately and the ticket will just bounce back to you. If everything capable enough is exhausted, assign what is available and say so in your notes; a simple ticket finished slowly on a free set beats a hard ticket that cannot start at all.",
  );
  return lines.join("\n");
}


/** Tells an agent what credentials it actually has, by name only. Agents
 * otherwise either assume they can push and fail confusingly at the end of
 * a ticket, or assume they can't and never try. Values are never rendered --
 * they're in the environment, and that's where they should stay. */
export function renderSecrets(names: string[], hasGit: boolean): string {
  if (!names.length) {
    return "## Credentials\n\nNone are configured for this project. You cannot authenticate to anything external — if the ticket needs that, report it as blocked rather than trying to work around it.";
  }
  return [
    "## Credentials",
    "",
    "These are in your environment as variables. Use them by name — never print one, echo one, write one into a file, commit one, or include one in your report:",
    ...names.map((name) => `- \`$${name}\``),
    "",
    hasGit
      ? "Git and the GitHub CLI (`gh`) are already authenticated with these, so `git push` and `gh pr create` will work without you configuring anything. Do not put a token in a remote URL."
      : "No git credentials are configured, so pushing and opening pull requests will fail. Commit locally and say so in your report.",
  ].join("\n");
}

export function renderProjectContext(projectName: string, settings: ProjectSettings, spentUsd: number): string {
  const budget = settings.budget.monthlyUsd;
  const lines = [
    `## Project: ${projectName}`,
    `Repository: ${settings.repoUrl ?? "none configured — the workspace directory is the working copy"}`,
    `Default branch: ${settings.defaultBranch}`,
    `Deploy target: ${settings.deployTarget}`,
  ];
  if (settings.docsPaths.length) lines.push(`Reference docs in the workspace: ${settings.docsPaths.join(", ")}`);
  lines.push(
    budget !== null
      ? `Agent budget this month: $${spentUsd.toFixed(2)} spent of $${budget.toFixed(2)}.`
      : `Agent budget this month: $${spentUsd.toFixed(2)} spent, no cap configured.`,
  );
  return lines.join("\n");
}
