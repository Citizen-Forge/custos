import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
      clientApiKey: config.clientApiKey ?? null,
    };
  });

  // -- Client API key (gates /v1/messages, /hooks/*, /memory/search) ------

  app.post("/admin/api/client-key/generate", async () => {
    const key = `custos-${randomBytes(24).toString("base64url")}`;
    await updateConfig(runtime, (cfg) => ({ ...cfg, clientApiKey: key }));
    return { clientApiKey: key };
  });

  app.post("/admin/api/client-key/clear", async () => {
    await updateConfig(runtime, (cfg) => ({ ...cfg, clientApiKey: undefined }));
    return { ok: true };
  });

  // -- Runtime stats ------------------------------------------------------

  app.get("/admin/api/runtime/stats", async () => {
    return runtime.stats();
  });
}
