import { JsonCollection, newId, pmPath } from "./store.js";
import type { AgentRole, AgentRun } from "./types.js";

const runs = new JsonCollection<AgentRun>(pmPath("agent-runs.json"));

/** Runs are an append-only activity feed, so the file would grow without
 * bound; keep the most recent slice per project and drop the rest on write. */
const MAX_RUNS_PER_PROJECT = 200;

export async function listRuns(projectId?: string, limit = 50): Promise<AgentRun[]> {
  const rows = projectId ? await runs.find((row) => row.projectId === projectId) : await runs.list();
  return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export async function listActiveRuns(projectId?: string): Promise<AgentRun[]> {
  const rows = await runs.find((row) => row.status === "running" && (!projectId || row.projectId === projectId));
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}

export async function startRun(input: {
  projectId: string;
  agentId: string;
  role: AgentRole;
  workItemId?: string | null;
  ideaId?: string | null;
}): Promise<AgentRun> {
  const run = await runs.insert({
    id: newId(),
    projectId: input.projectId,
    agentId: input.agentId,
    role: input.role,
    workItemId: input.workItemId ?? null,
    ideaId: input.ideaId ?? null,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    claudeSessionId: null,
    costUsd: null,
    summary: "",
    error: null,
  });
  await prune(input.projectId);
  return run;
}

export async function setRunSession(id: string, claudeSessionId: string): Promise<void> {
  await runs.update(id, (run) => {
    run.claudeSessionId = claudeSessionId;
  });
}

export async function finishRun(id: string, outcome: { status: "succeeded" | "failed"; summary?: string; error?: string | null; costUsd?: number | null }): Promise<AgentRun | null> {
  return runs.update(id, (run) => {
    run.status = outcome.status;
    run.endedAt = Date.now();
    run.summary = (outcome.summary ?? "").slice(0, 4000);
    run.error = outcome.error ?? null;
    run.costUsd = outcome.costUsd ?? null;
  });
}

/** Agent spend for this project so far this calendar month, in USD.
 * Only Anthropic-billed turns report a cost (Claude Code's own
 * total_cost_usd), so this is a floor on true spend rather than an exact
 * ledger -- local/free models legitimately contribute nothing to it. */
export async function monthlySpendUsd(projectId: string): Promise<number> {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const rows = await runs.find((row) => row.projectId === projectId && row.startedAt >= monthStart);
  return rows.reduce((total, row) => total + (row.costUsd ?? 0), 0);
}

/** Marks every still-"running" row as failed. Called at startup: a run's
 * liveness lives in the orchestrator's memory, so anything left running in
 * the file after a restart is a ghost, not work still in flight. */
export async function failOrphanedRuns(): Promise<number> {
  const orphans = await runs.find((row) => row.status === "running");
  for (const orphan of orphans) {
    await finishRun(orphan.id, { status: "failed", error: "interrupted by a gateway restart" });
  }
  return orphans.length;
}

async function prune(projectId: string): Promise<void> {
  const rows = await runs.find((row) => row.projectId === projectId);
  if (rows.length <= MAX_RUNS_PER_PROJECT) return;
  const cutoff = rows.sort((a, b) => b.startedAt - a.startedAt)[MAX_RUNS_PER_PROJECT].startedAt;
  await runs.removeWhere((row) => row.projectId === projectId && row.status !== "running" && row.startedAt < cutoff);
}

export async function deleteProjectRuns(projectId: string): Promise<number> {
  return runs.removeWhere((row) => row.projectId === projectId);
}
