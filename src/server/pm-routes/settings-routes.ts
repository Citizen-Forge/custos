import type { FastifyInstance } from "fastify";
import * as agentStore from "../../pm/agents.js";
import * as runs from "../../pm/runs.js";
import { getSettings, updateSettings } from "../../pm/project-settings.js";
import type { ProjectSettings } from "../../pm/types.js";

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/admin/api/projects/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    await agentStore.ensureProjectAgents(id);
    return {
      settings: await getSettings(id),
      agents: await agentStore.listAgents(id),
      spentUsd: await runs.monthlySpendUsd(id),
      subscriptionUsd: await runs.monthlyUnbilledUsd(id),
    };
  });

  app.patch("/admin/api/projects/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Partial<Omit<ProjectSettings, "id">>;
    return { settings: await updateSettings(id, patch) };
  });
}
