import type { FastifyInstance } from "fastify";
import { sessions, SESSION_COOKIE } from "../auth/admin-session.js";

function isProtectedPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/") || path === "/remote" || path.startsWith("/remote/");
}

/**
 * Only /admin* and /remote* require a session -- everything else (the
 * actual proxy traffic at /v1/messages, the /hooks/* endpoints Claude Code
 * calls out to) is deliberately left open, since Claude Code has no way
 * to authenticate as "the admin browsing a UI" and was never meant to.
 * This is the boundary between "routing/gating infrastructure" and
 * "things a human operates," and remote control's shell access is exactly
 * why the latter needed real auth instead of "reachable on your LAN."
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!isProtectedPath(path)) return;

    if (sessions.isValid(req.cookies[SESSION_COOKIE])) return;

    const isPageLoad = req.method === "GET" && !path.startsWith("/admin/api") && path !== "/remote/ws";
    if (isPageLoad) {
      reply.redirect(`/login?next=${encodeURIComponent(path)}`);
      return;
    }
    reply.code(401).send({ error: "authentication required" });
  });
}
