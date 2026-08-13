import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../pm/orchestrator.js";
import { listProjects as listAllProjects } from "../../remote/projects.js";
import * as board from "../../pm/board.js";
import * as agentStore from "../../pm/agents.js";
import * as runs from "../../pm/runs.js";
import { buildNowWorking, resolveWorkItemTitles, type NowWorkingSummary } from "../../pm/now-working.js";

export function registerActivityRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.get("/admin/api/projects/:id/activity", async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    const pastRuns = await runs.listRuns(id, Number(limit) || 50);
    const active = await runs.listActiveRuns(id);
    const stalled = await runs.listStalledRuns(id);
    const stalledRunIds = stalled.map((run) => run.id);

    // Resolve work-item titles once for every work item referenced by
    // any run in the response (active + past). Hand-off to the shared
    // helper which keeps the per-agent lookup O(1) via pre-built maps.
    const itemTitles = await resolveWorkItemTitles(
      [...active, ...pastRuns].map((r) => r.workItemId),
      (wid) => board.getWorkItem(wid),
    );

    const nowWorking = buildNowWorking(
      await agentStore.listAgents(id),
      active,
      pastRuns,
      stalledRunIds,
      itemTitles,
    );
    // Same per-agent on-disk shape the existing UI consumes (a map
    // keyed by agentId) -- the consumer doesn't have to learn the
    // cross-project array shape.
    const nowWorkingByAgent: Record<string, NowWorkingSummary> = Object.fromEntries(
      nowWorking.map((row) => [row.agentId, row.summary]),
    );

    return {
      runs: pastRuns,
      active,
      stalledRunIds,
      busy: orchestrator.activeKeys(),
      nowWorkingByAgent,
    };
  });

  /** Fleet-wide "all agents, all projects" -- aggregates the per-project
   *  activity response into a single payload so the admin UI can render
   *  one consolidated roster view without N round-trips. Internally
   *  fans out to the same shared enrichment helper as the per-project
   *  endpoint, so a bug fix to the work-item-title resolution or the
   *  status picking drops into both surfaces at once.
   *
   *  Response shape is keyed by (projectId, agentId) tuples so agent
   *  IDs aren't ambiguous across projects (the per-project Map shape
   *  the existing UI uses won't survive project boundaries). */
  app.get("/admin/api/now-working", async () => {
    const projects = await listAllProjects();
    // Resolve work-item titles across ALL projects in a single batch --
    // avoids a per-project lookup waterfall when the fleet is idle and
    // resolves the moment a poll returns with no new activity.
    const allWorkItemIds: Array<string | null> = [];
    const perProjectRuns: Array<{
      project: typeof projects[number];
      agents: Awaited<ReturnType<typeof agentStore.listAgents>>;
      active: Awaited<ReturnType<typeof runs.listActiveRuns>>;
      past: Awaited<ReturnType<typeof runs.listRuns>>;
      stalledIds: string[];
    }> = [];
    for (const project of projects) {
      const [agents, active, past, stalled] = await Promise.all([
        agentStore.listAgents(project.id),
        runs.listActiveRuns(project.id),
        runs.listRuns(project.id, 50),
        runs.listStalledRuns(project.id),
      ]);
      perProjectRuns.push({
        project,
        agents,
        active,
        past,
        stalledIds: stalled.map((r) => r.id),
      });
      for (const r of [...active, ...past]) allWorkItemIds.push(r.workItemId);
    }
    const itemTitles = await resolveWorkItemTitles(allWorkItemIds, (wid) => board.getWorkItem(wid));

    const result = perProjectRuns.map((entry) => ({
      id: entry.project.id,
      name: entry.project.name,
      agents: buildNowWorking(
        entry.agents,
        entry.active,
        entry.past,
        entry.stalledIds,
        itemTitles,
      ),
    }));

    return {
      generatedAt: Date.now(),
      // orchestrator.activeKeys() returns the fleet-wide busy list, not
      // per-project -- hanging it under every project would duplicate
      // the same array N times. Top-level placement makes the wire
      // shape honest about what "busy" means.
      busy: orchestrator.activeKeys(),
      projects: result,
    };
  });
}
