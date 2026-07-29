// Removed — custos is no longer a Claude Code proxy. The /v1/messages,
// /hooks/*, and /memory/search endpoints are reachable only from custos's
// own spawned subprocesses, so the shared-secret client-auth gate is dead
// weight. The function is preserved as a no-op so leftover registrations
// fail loud at startup rather than silently doing nothing.

import type { FastifyInstance } from "fastify";

export function registerClientAuthGuard(_app: FastifyInstance): void {
  // no-op
}
