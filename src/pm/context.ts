import type { ProviderOption } from "./agents.js";
import type { AgentDef, Idea, ProjectSettings, WorkItem } from "./types.js";

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

export function renderAgentRoster(roster: AgentDef[]): string {
  if (!roster.length) return "_No engineer agents exist yet — you will need to create at least one._";
  return roster
    .map((agent) => {
      const s = agent.stats;
      const bounceRate = s.completed ? `${Math.round((s.qaRejections / s.completed) * 100)}%` : "n/a";
      return [
        `### \`${agent.id}\` — ${agent.name}`,
        `Runs on: ${agent.providerKey} / ${agent.model} · rated up to **${agent.maxComplexity}** complexity`,
        `Specialty: ${agent.specialty ?? "unspecified"}`,
        `Record: ${s.assigned} assigned, ${s.completed} completed, ${s.qaRejections} QA bounces (${bounceRate} of completed), $${s.totalCostUsd.toFixed(2)} spent, ${Math.round(s.avgRunMs / 1000)}s average run`,
        agent.notes.length ? `Existing tuning notes:\n${agent.notes.map((n) => `  - ${n}`).join("\n")}` : "No tuning notes yet.",
      ].join("\n");
    })
    .join("\n\n");
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
