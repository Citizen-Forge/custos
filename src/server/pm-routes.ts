import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { Orchestrator } from "../pm/orchestrator.js";
import { registerRoadmapRoutes } from "./pm-routes/roadmap-routes.js";
import { registerBoardRoutes } from "./pm-routes/board-routes.js";
import { registerAgentRoutes } from "./pm-routes/agent-routes.js";
import { registerSettingsRoutes } from "./pm-routes/settings-routes.js";
import { registerVaultRoutes } from "./pm-routes/vault-routes.js";
import { registerActivityRoutes } from "./pm-routes/activity-routes.js";
import { registerLifecycleRoutes } from "./pm-routes/lifecycle-routes.js";
import { registerFactsRoutes } from "./pm-routes/facts-routes.js";

/**
 * The project-management surface behind the four project tabs. All of it
 * sits under /admin/api and is gated by the same session login as the rest
 * of the admin API -- these endpoints move real work and spend real money,
 * so they're deliberately not on the client-API-key surface that Claude
 * Code itself authenticates against.
 *
 * Split by concern under ./pm-routes/: roadmap (ideas), board (work items +
 * manual stage triggers), agents, settings, vault (secrets), activity
 * (per-project + fleet-wide now-working), lifecycle (pause/resume/PM
 * reset), and facts.
 */
export function registerPmRoutes(app: FastifyInstance, runtime: Runtime, orchestrator: Orchestrator): void {
  registerRoadmapRoutes(app, orchestrator);
  registerBoardRoutes(app, orchestrator);
  registerAgentRoutes(app, runtime);
  registerSettingsRoutes(app);
  registerVaultRoutes(app);
  registerActivityRoutes(app, orchestrator);
  registerLifecycleRoutes(app, orchestrator);
  registerFactsRoutes(app);
}
