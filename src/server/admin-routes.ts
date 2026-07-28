import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerAnthropicRoutes } from "./anthropic-routes.js";
import { registerProviderRoutes } from "./provider-routes.js";
import { registerRoutingRoutes } from "./routing-routes.js";
import { registerGlobalAgentRoutes } from "./global-agent-routes.js";

/**
 * Registers all /admin/api/* routes by delegating to domain-specific
 * registration functions. Each sub-file owns a coherent group of routes
 * that share the same config-surface concern.
 *
 *   config-routes.ts        state, version, admin page, runtime stats
 *   anthropic-routes.ts     OAuth, API key, throttle
 *   provider-routes.ts      CRUD, probe, model toggle
 *   routing-routes.ts       task priorities (legacy compat)
 *   global-agent-routes.ts  global services (memory curator, classifier, embeddings)
 */
export function registerAdminRoutes(app: FastifyInstance, runtime: Runtime): void {
  registerConfigRoutes(app, runtime);
  registerAnthropicRoutes(app, runtime);
  registerProviderRoutes(app, runtime);
  registerRoutingRoutes(app, runtime);
  registerGlobalAgentRoutes(app, runtime);
}
