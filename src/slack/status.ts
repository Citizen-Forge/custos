import * as board from "../pm/board.js";
import * as agentStore from "../pm/agents.js";

const MAX_LISTED = 5;
const RECENTLY_COMPLETED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Answers an @-mention like "what's in progress?" or "status update"
 *  directly from board state -- deterministic, no agent turn spawned.
 *  "What's being worked on" is a database query, not something worth the
 *  cost and (per this project's own history) multi-minute local-model
 *  turnaround of a real product-owner dispatch to answer. A future pass
 *  could route genuinely open-ended questions ("why is X blocked") to a
 *  real agent turn; every question this was actually asked for is
 *  answerable from the board alone. */
export async function buildStatusReply(projectId: string, projectName: string): Promise<string> {
  const byStatus = await board.listBoard(projectId);
  const agents = await agentStore.listAgents(projectId);
  const nameFor = (id: string | null): string | null => {
    if (!id) return null;
    const agent = agents.find((a) => a.id === id);
    return agent ? agentStore.displayName(agent) : null;
  };
  const titles = (items: { title: string }[]) => items.slice(0, MAX_LISTED).map((i) => i.title).join(", ") + (items.length > MAX_LISTED ? `, +${items.length - MAX_LISTED} more` : "");

  const lines: string[] = [`*${projectName} — status*`];

  const inProgress = byStatus.in_progress;
  lines.push("", `*In progress* (${inProgress.length})`);
  if (inProgress.length) {
    for (const item of inProgress) {
      const who = nameFor(item.assigneeAgentId);
      lines.push(`• ${item.title}${who ? ` — _${who}_` : ""}`);
    }
  } else {
    lines.push("_nothing right now_");
  }

  const qa = byStatus.qa;
  if (qa.length) {
    lines.push("", `*In QA* (${qa.length})`);
    for (const item of qa) lines.push(`• ${item.title}`);
  }

  const ready = byStatus.ready;
  lines.push("", `*Ready to start*: ${ready.length}${ready.length ? ` — ${titles(ready)}` : ""}`);

  lines.push(`*Backlog*: ${byStatus.backlog.length}`);

  const recentlyCompleted = byStatus.complete.filter((item) => Date.now() - item.updatedAt < RECENTLY_COMPLETED_WINDOW_MS);
  if (recentlyCompleted.length) {
    lines.push("", `*Completed this week*: ${recentlyCompleted.length} — ${titles(recentlyCompleted)}`);
  }

  return lines.join("\n");
}
