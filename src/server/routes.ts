import type { FastifyInstance } from "fastify";
import { registerMessagesRoute } from "./routes/messages-route.js";
import { registerHooksRoutes } from "./routes/hooks-routes.js";
import { registerMemoryRoutes } from "./routes/memory-routes.js";
import type { RouteDeps } from "./routes/types.js";

export type { RouteDeps } from "./routes/types.js";

/** The client-facing proxy surface: /v1/messages (the Anthropic Messages
 * API every spawned `claude` subprocess talks to), the /hooks/* endpoints
 * those subprocesses call out to for permission decisions, and
 * /memory/search. Deliberately not gated by the admin session login --
 * Claude Code has no way to authenticate as "the admin browsing a UI" --
 * see auth-guard.ts's doc comment for the full boundary. Split by concern
 * under ./routes/: messages-route.ts (the dispatch chain construction and
 * streaming/non-streaming response handling), hooks-routes.ts (the five
 * PreToolUse/PostToolUse/UserPromptSubmit variants), memory-routes.ts. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/health", async () => {
    const { getCommitHash } = await import("../version.js");
    return { ok: true, commit: await getCommitHash() };
  });

  registerMessagesRoute(app, deps);
  registerHooksRoutes(app, deps);
  registerMemoryRoutes(app, deps);
}
