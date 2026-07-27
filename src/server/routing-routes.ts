import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { TaskKind, ComplexityTier } from "../types.js";
import type { ProviderEntry } from "../config.js";
import { updateConfig } from "./admin-shared.js";

const TASK_KINDS: TaskKind[] = ["general", "permissionClassifier", "memoryCurator", "complexityClassifier"];
const COMPLEXITY_TIERS: ComplexityTier[] = ["low", "medium", "high"];

export function registerRoutingRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.put("/admin/api/tasks/:taskKind", async (req, reply) => {
    const { taskKind } = req.params as { taskKind: string };
    if (!TASK_KINDS.includes(taskKind as TaskKind)) {
      reply.code(400);
      return { error: `unknown task "${taskKind}"` };
    }
    const { entries } = req.body as { entries: ProviderEntry[] };
    await updateConfig(runtime, (cfg) => ({ ...cfg, tasks: { ...cfg.tasks, [taskKind]: entries } }));
    return { ok: true };
  });

  app.put("/admin/api/complexity-routing", async (req, reply) => {
    const body = req.body as { enabled: boolean; tiers: Record<ComplexityTier, ProviderEntry[]> };
    for (const tier of COMPLEXITY_TIERS) {
      if (!body.tiers[tier]) {
        reply.code(400);
        return { error: `missing tier "${tier}"` };
      }
    }
    await updateConfig(runtime, (cfg) => ({ ...cfg, complexityRouting: { enabled: body.enabled, tiers: body.tiers } }));
    return { ok: true };
  });
}
