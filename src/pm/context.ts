import type { ProviderOption } from "./agents.js";
import { isAvailable, type ModelRecord } from "./model-registry.js";
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

export function renderWorkItem(item: WorkItem, opts: { includeComments?: boolean; includeHistory?: boolean } = {}): string {
  const lines = [
    `### ${item.type.toUpperCase()} ${item.id} — ${item.title}`,
    `Status: ${item.status}${item.complexity ? ` · complexity: ${item.complexity}` : ""}${item.qaRounds ? ` · bounced by QA ${item.qaRounds}x` : ""}`,
  ];
  if (item.labels.length) lines.push(`Labels: ${item.labels.join(", ")}`);
  if (item.branch) lines.push(`Branch: ${item.branch}`);
  if (item.prUrl) lines.push(`Pull request: ${item.prUrl}`);
  if (item.description.trim()) lines.push("", item.description.trim());
  if (item.acceptanceCriteria.length) {
    lines.push("", "**Acceptance criteria**", ...item.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (item.subtasks.length) {
    lines.push("", "**Subtasks**", ...item.subtasks.map((s) => `- [${s.done ? "x" : " "}] ${s.title}`));
  }
  if (opts.includeComments && item.comments.length) {
    lines.push("", "**Comments**", ...item.comments.map((c) => `- **${c.authorLabel}**: ${c.body}`));
  }
  if (opts.includeHistory && item.history.length) {
    lines.push("", "**History**", ...item.history.map((h) => `- ${new Date(h.at).toISOString()} ${h.actor}: ${h.from ?? "—"} → ${h.to}${h.note ? ` (${h.note})` : ""}`));
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

const BILLING_BLURB: Record<string, string> = {
  subscription: "covered by the Claude subscription — costs nothing per token, but the usage window runs out and then this is unusable for hours",
  metered: "billed per token against the project budget",
  free: "free tier or self-hosted — no cost, usually rate limited or slower",
};

/**
 * The menu the engineering manager actually decides from: what each
 * combination costs, how capable it has proved to be, and whether it can be
 * used at all right now. Exhausted entries are listed rather than hidden --
 * the manager needs to know a strong model exists and is temporarily gone,
 * so it can route around it deliberately instead of behaving as though the
 * model never existed.
 */
export function renderModelMenu(records: ModelRecord[]): string {
  if (!records.length) return "_No providers are configured._";
  const lines: string[] = [];
  for (const record of records) {
    const available = isAvailable(record);
    const evidence = record.completed + record.qaFailures;
    const track = evidence
      ? `${record.completed} passed / ${record.qaFailures} bounced`
      : "no track record yet";
    const status = available
      ? "**available**"
      : `**EXHAUSTED** until ${new Date(record.unavailableUntil ?? 0).toISOString()} (${record.unavailableReason ?? "no reason given"})`;
    lines.push(
      `- \`${record.providerKey}\` / \`${record.model}\` — capability **${record.capability.toFixed(2)}/5** (${track}) · ${BILLING_BLURB[record.billing]} · ${status}`,
    );
  }
  lines.push(
    "",
    "Capability is measured, not assumed: it starts from the model's tier and then moves with QA's verdicts on work that model produced. Trust it over your own prior about which model name sounds strongest.",
    "",
    "**Never assign work to an exhausted combination** — the run will fail immediately and the ticket will just bounce back to you. If everything capable enough is exhausted, assign what is available and say so in your notes; a simple ticket finished slowly on a free model beats a hard ticket that cannot start at all.",
  );
  return lines.join("\n");
}

export function renderProviderMenu(options: ProviderOption[]): string {
  return options
    .map((option) => {
      const cost = option.free
        ? "**free** — does not draw down the project budget"
        : option.inputPerMTok !== null
          ? `$${option.inputPerMTok}/M input, $${option.outputPerMTok}/M output`
          : "metered, price not configured";
      const cap = option.budgetUsd !== null ? ` · hard cap $${option.budgetUsd}` : "";
      return `- providerKey \`${option.providerKey}\`, model \`${option.model}\` — ${cost}${cap}`;
    })
    .join("\n");
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
