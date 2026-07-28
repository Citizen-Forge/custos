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
      embeddingProvider: config.embeddingProvider,
      providerPresets: PROVIDER_PRESETS,
    };
  });

  // -- Runtime stats ------------------------------------------------------

  app.get("/admin/api/runtime/stats", async () => {
    return runtime.stats();
  });
}
