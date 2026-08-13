import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { registerInstanceRoutes } from "./provider-routes/instance-routes.js";
import { registerLegacyInstanceRoutes } from "./provider-routes/legacy-instance-routes.js";

/** Admin API for the two provider config shapes: the current
 * `providers.<name>` (multi-model) shape and the legacy
 * `openaiCompatibleInstances` (one-instance-one-model) shape it
 * superseded. Split under ./provider-routes/: instance-routes.ts (current
 * shape), legacy-instance-routes.ts (backward compat), enrich-model.ts
 * (the /v1/models response enrichment shared by both probes). */
export function registerProviderRoutes(app: FastifyInstance, runtime: Runtime): void {
  registerInstanceRoutes(app, runtime);
  registerLegacyInstanceRoutes(app, runtime);
}
