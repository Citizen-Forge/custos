import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Runtime } from "../runtime.js";

function isProtectedClientPath(path: string): boolean {
  return path === "/v1/messages" || path.startsWith("/hooks/") || path === "/memory/search";
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Shared-secret check for the client-facing proxy surface --
 * /v1/messages, /hooks/*, /memory/search -- everything a Claude Code
 * instance calls directly, as opposed to /admin and /remote paths, which
 * are gated by the session-cookie login instead (see auth-guard.ts).
 * Fails closed: no clientApiKey configured means every request here is
 * rejected, not allowed through. Generating a key (admin UI's Security
 * panel) is a required setup step, not an opt-in hardening measure --
 * there's no supported "open" mode for this surface.
 */
export function registerClientAuthGuard(app: FastifyInstance, runtime: Runtime): void {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!isProtectedClientPath(path)) return;

    const configuredKey = runtime.config.clientApiKey;
    if (!configuredKey) {
      reply.code(401).send({
        type: "error",
        error: { type: "authentication_error", message: "no client API key configured yet -- generate one in the admin UI's Security panel" },
      });
      return;
    }

    const provided = req.headers["x-api-key"];
    if (typeof provided !== "string" || !safeEqual(provided, configuredKey)) {
      reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "invalid or missing x-api-key" } });
    }
  });
}
