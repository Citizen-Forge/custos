import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../runtime.js";
import { getApiKeySource } from "../config.js";
import { getOAuthStatus } from "../auth/credentials.js";
import { maskApiKey, describeProviders, updateConfig, PROVIDER_PRESETS } from "./admin-shared.js";

export function registerConfigRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get("/admin/api/version", async () => {
    const { getCommitHash } = await import("../version.js");
    return { commit: await getCommitHash() };
  });

  app.get("/admin", async (_req, reply) => {
    const html = await readFile(join(process.cwd(), "public", "admin.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(html);
  });

  // -- State (composite of config + derived data) ------------------------

  app.get("/admin/api/state", async () => {
    const config = runtime.config;
    const apiKeySource = await getApiKeySource();
    const oauth = await getOAuthStatus();

    return {
      anthropic: {
        apiKeySource,
        apiKeyMasked: config.anthropic?.apiKey ? maskApiKey(config.anthropic.apiKey) : null,
        oauth,
        maxConcurrent: config.anthropic?.maxConcurrent ?? null,
        rpmLimit: config.anthropic?.rpmLimit ?? null,
      },
      providers: await describeProviders(runtime),
      // Embeddings live on the global agent with systemRole "embeddings"
      // (see /admin/api/global-agents GET). The runtime derives the
      // host/model at every reload, so the surface for "which model is
      // used for embeddings" is the Global Services panel, not a top-
      // level config node. Surfacing the field here would create a
      // second source of truth the admin UI would have to reconcile.
      fallbackSets: config.fallbackSets ?? {},
      providerPresets: PROVIDER_PRESETS,
    };
  });

  // -- Runtime stats ------------------------------------------------------

  app.get("/admin/api/runtime/stats", async () => {
    return runtime.stats();
  });

  // -- Queue activity log ------------------------------------------------
  //
  // Recent dispatch events from the global queue. Each event captures
  // project + agent + fallback set + provider/model + outcome so an
  // operator can see what work is flowing through which provider, who
  // initiated it, and whether it succeeded or fell through the chain.
  // The buffer is bounded (see activity-log.ts MAX_EVENTS); the `limit`
  // query param caps the slice returned. Auto-poll from the admin panel
  // keeps this fresh without a separate streaming endpoint.

  app.get<{ Querystring: { limit?: string } }>("/admin/api/queue/activity", async (req) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
    return {
      events: runtime.activityLog.recent(limit),
      capacity: runtime.activityLog.size,
    };
  });
}
