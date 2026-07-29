// Shared per-agent "now working on" enrichment. Extracted from the
// per-project activity handler so the cross-project dashboard can
// reuse the same logic -- identical semantics (active wins over past,
// O(1) Map lookups, 120-char truncation, work-item-title resolution,
// deleted-item flagging) across both surfaces means a fleet-wide bug
// fix lands in one place instead of two.
//
// NowWorkingSummary is declared locally because src/ and ui/ are
// separate TS projects with different module kinds (src/ is CJS,
// ui/ is ESM) -- crossing the boundary at the type level triggers a
// rootDir + module-kind mismatch. The canonical shape lives in
// ui/src/shared/types.ts; any drift between the two copies is a
// reviewable bug, not silent divergence.

export interface NowWorkingSummary {
  /** "running" = currently executing, "succeeded"/"failed" = most recent
   * completed run, "idle" = no runs in the recent window. */
  status: "running" | "succeeded" | "failed" | "idle";
  /** The run this snapshot is drawn from. Absent for "idle". */
  runId?: string;
  /** For "running": true if lastEventAt is older than the stall
   * threshold. For completed runs: always omitted. */
  isStalled?: boolean;
  /** The work item ID the agent is operating on, or null if there's no
   * ticket. Surfaced alongside workItemTitle so the UI can render a
   * click-through link to the board without a second round-trip. */
  workItemId?: string | null;
  /** Resolved work item title, or null if there is no workItemId. */
  workItemTitle?: string | null;
  /** True if workItemId was set but getWorkItem returned null. */
  workItemDeleted?: boolean;
  /** For "running": the latest heartbeat text (truncated). */
  currentAction?: string | null;
  /** For completed runs: the run's summary text (truncated). */
  summary?: string | null;
  /** For failed runs: the error message, if any. */
  error?: string | null;
  /** QA's verdict on this agent's most recent output, attached by runQa
   * onto the engineer's run row. Surfaced on the engineer's card so a
   * glance at "Last QA bounce: <reason>" answers why the rejection rate is
   * climbing without clicking into run details. Absent for QA/devops/
   * product-owner runs themselves (they produce work, not take review).
   * Inline-fail criteria are picked at write-time -- the dataclass carries
   * the verdict that flipped the outcome, not the full criteria array. */
  lastQaBounce?: {
    verdict: "pass" | "fail";
    criterion?: string;
    evidence?: string;
  } | null;
  startedAt?: number;
  lastEventAt?: number;
  endedAt?: number | null;
}

/** Shape returned to the agent-row consumer -- now-working summary plus
 * the agent's stable id so cross-project callers can disambiguate. */
export interface AgentNowWorking {
  agentId: string;
  agentName: string;
  role: string;
  /** The fallback set name surfaced on the agent row, so the fleet
   * dashboard can group agents by their primary pick ("all agents on
   * the complex fallback set" is a useful drill-down even before
   * we expose it as a filter). */
  fallbackSet?: string | null;
  summary: NowWorkingSummary;
}

/** Build the per-agent snapshot given the raw run lists + pre-resolved
 * work-item titles. The pre-built map shape (active + past runs + the
 * title cache) keeps the loop O(agents) instead of O(agents *
 * runs) -- matters for the cross-project endpoint which iterates
 * every project's agents on every poll. */
export function buildNowWorking(
  agents: Array<{
    id: string;
    name: string;
    role: string;
    fallbackSet?: string | null;
  }>,
  active: ReadonlyArray<{ agentId: string; id: string; status: string; workItemId: string | null; currentAction: string | null; startedAt: number; lastEventAt: number; error: string | null }>,
  pastRuns: ReadonlyArray<{ agentId: string; id: string; status: string; workItemId: string | null; summary: string; error: string | null; startedAt: number; endedAt: number | null; qaBounce?: { verdict: "pass" | "fail"; criterion?: string; evidence?: string } }>,
  stalledIds: ReadonlyArray<string>,
  itemTitles: Record<string, string | null>,
): AgentNowWorking[] {
  const activeByAgent = new Map(active.map((r) => [r.agentId, r]));
  const lastRunByAgent = new Map<string, typeof pastRuns[number]>();
  for (const run of pastRuns) {
    if (!lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, run);
  }
  const stalledSet = new Set(stalledIds);

  const out: AgentNowWorking[] = [];
  for (const agent of agents) {
    const activeRun = activeByAgent.get(agent.id);
    let summary: NowWorkingSummary;
    if (activeRun) {
      const hasWid = Boolean(activeRun.workItemId);
      const title = hasWid ? (itemTitles[activeRun.workItemId as string] ?? null) : null;
      summary = {
        status: "running",
        runId: activeRun.id,
        isStalled: stalledSet.has(activeRun.id),
        // workItemId is the click-through target on the Team tab; carrying
        // it alongside the resolved title avoids a second round-trip
        // when the operator clicks into the work item.
        workItemId: hasWid ? activeRun.workItemId : null,
        workItemTitle: title ?? (hasWid ? `${activeRun.workItemId} (deleted)` : null),
        workItemDeleted: hasWid && title === null,
        currentAction: activeRun.currentAction ? activeRun.currentAction.slice(0, 120) : null,
        startedAt: activeRun.startedAt,
        lastEventAt: activeRun.lastEventAt,
      };
    } else {
      const lastRun = lastRunByAgent.get(agent.id);
      if (lastRun) {
        const hasWid = Boolean(lastRun.workItemId);
        const title = hasWid ? (itemTitles[lastRun.workItemId as string] ?? null) : null;
        const status: "succeeded" | "failed" =
          lastRun.status === "running" ? "failed" : (lastRun.status as "succeeded" | "failed");
        summary = {
          status,
          runId: lastRun.id,
          workItemId: hasWid ? lastRun.workItemId : null,
          workItemTitle: title ?? (hasWid ? `${lastRun.workItemId} (deleted)` : null),
          workItemDeleted: hasWid && title === null,
          summary: lastRun.summary ? lastRun.summary.slice(0, 120) : null,
          error: lastRun.error ?? null,
          // The QA verdict carries forward from the agent-runner row
          // populated by runQa -- no separate lookup needed because the
          // engineer row IS the surface whose stats card shows qaRejections.
          lastQaBounce: lastRun.qaBounce ?? null,
          startedAt: lastRun.startedAt,
          endedAt: lastRun.endedAt,
        };
      } else {
        summary = { status: "idle" };
      }
    }
    out.push({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      fallbackSet: agent.fallbackSet ?? null,
      summary,
    });
  }
  return out;
}

/** Bulk-resolve work-item titles for an arbitrary list of runs. Returns
 * a map keyed by workItemId suitable for direct lookup. */
export async function resolveWorkItemTitles(
  workItemIds: ReadonlyArray<string | null>,
  lookup: (id: string) => Promise<{ title: string } | null>,
): Promise<Record<string, string | null>> {
  const ids = Array.from(new Set(workItemIds.filter((w): w is string => Boolean(w))));
  const titles = await Promise.all(ids.map((id) => lookup(id)));
  const out: Record<string, string | null> = {};
  ids.forEach((id, idx) => { out[id] = titles[idx]?.title ?? null; });
  return out;
}
