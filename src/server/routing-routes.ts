import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { TaskKind } from "../types.js";
import type { ProviderEntry } from "../config.js";
import { updateConfig } from "./admin-shared.js";

// `Task routing` and `complexity routing` UIs in the admin panel were
// dropped with the pivot to orchestrator-driven model assignment. The PUT
// handlers below stay so a manual `curl` against /admin/api/tasks/<kind>
// still works for power users, but nothing in the admin UI calls them.
// Notably the complexity-routing endpoint is gone -- that path is fully
// deprecated: per-turn classification no longer exists in /v1/messages,
// the schema field is gone, and the prior endpoint would 400 on the
// missing field on save.
const TASK_KINDS: TaskKind[] = ["general", "permissionClassifier", "memoryCurator"];

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
}
