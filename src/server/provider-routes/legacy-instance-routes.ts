import type { FastifyInstance } from "fastify";
import type { Runtime } from "../../runtime.js";
import type { PricingConfig } from "../../providers/spend-tracker.js";
import type { Priority } from "../../providers/types.js";
import { findInstanceUsages, resolveApiKey, resolveOptionalInt, updateConfig } from "../admin-shared.js";
import { enrichModel } from "./enrich-model.js";

/** Backward-compat routes for the old `openaiCompatibleInstances` shape --
 * one instance, one model, one base URL. Superseded by the `providers.<name>`
 * shape (see ./instance-routes.ts), but still reachable so an operator on
 * an old config isn't stranded. */
export function registerLegacyInstanceRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.put("/admin/api/instances/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, model, apiKey, pricing, maxConcurrent, priority, rpmLimit, maxRequestBytes, embeddingUrl } = req.body as {
      baseUrl: string;
      model: string;
      apiKey?: string | null;
      pricing?: PricingConfig | null;
      maxConcurrent?: number | null;
      rpmLimit?: number | null;
      maxRequestBytes?: number | null;
      priority?: Priority | null;
      embeddingUrl?: string | null;
    };
    if (!baseUrl || !model) {
      reply.code(400);
      return { error: "baseUrl and model are required" };
    }
    if (maxConcurrent !== undefined && maxConcurrent !== null &&
        (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)) {
      reply.code(400);
      return { error: "maxConcurrent must be a positive integer (set to null to disable the throttle)" };
    }
    if (rpmLimit !== undefined && rpmLimit !== null &&
        (!Number.isInteger(rpmLimit) || rpmLimit < 1)) {
      reply.code(400);
      return { error: "rpmLimit must be a positive integer (set to null for unlimited)" };
    }
    if (maxRequestBytes !== undefined && maxRequestBytes !== null &&
        (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1024)) {
      reply.code(400);
      return { error: "maxRequestBytes must be a positive integer >= 1024 (set to null for unlimited)" };
    }
    if (priority !== undefined && priority !== null && priority !== "interactive" && priority !== "background") {
      reply.code(400);
      return { error: `priority must be "interactive", "background", or null (got ${JSON.stringify(priority)})` };
    }
    if (embeddingUrl !== undefined && embeddingUrl !== null && embeddingUrl !== "") {
      try {
        new URL(embeddingUrl);
      } catch {
        reply.code(400);
        return { error: `embeddingUrl "${embeddingUrl}" is not a valid URL` };
      }
    }
    const costType = pricing ? "metered" : "free";
    await updateConfig(runtime, (cfg) => ({
      ...cfg,
      providers: {
        ...cfg.providers,
        [name]: {
          baseUrl,
          costType,
          models: [{ name: model, enabled: true, ...(pricing ? { pricing } : {}) }],
          apiKey: resolveApiKey(apiKey, cfg.providers?.[name]?.apiKey),
            maxConcurrent: resolveOptionalInt(maxConcurrent, cfg.providers?.[name]?.maxConcurrent),
            rpmLimit: resolveOptionalInt(rpmLimit, cfg.providers?.[name]?.rpmLimit),
            maxRequestBytes: resolveOptionalInt(maxRequestBytes, cfg.providers?.[name]?.maxRequestBytes),
            priority: priority ?? undefined,
            embeddingUrl: embeddingUrl ? embeddingUrl : undefined,
          },
        },
    }));
    return { ok: true };
  });

  app.delete("/admin/api/instances/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const usages = await findInstanceUsages(name);
    if (usages.length > 0) {
      reply.code(409);
      return { error: `"${name}" is still referenced by: ${usages.join(", ")} -- remove those references first` };
    }
    await updateConfig(runtime, (cfg) => {
      const { [name]: _removed, ...rest } = cfg.providers ?? {};
      return { ...cfg, providers: rest };
    });
    return { ok: true };
  });

  // POST (not GET+querystring) because this may carry a real third-party
  // API key while probing an as-yet-unsaved instance -- keeping it out of
  // URLs avoids it landing in access logs. Also used by the new-provider
  // add form's "Scan models" button, which has nothing saved yet either.
  app.post("/admin/api/instances/probe-models", async (req, reply) => {
    const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string };
    if (!baseUrl) {
      reply.code(400);
      return { error: "baseUrl is required" };
    }
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        reply.code(502);
        return { error: `HTTP ${res.status} from ${baseUrl}/models` };
      }
      const json = (await res.json()) as {
        data?: Record<string, unknown>[];
      };
      return {
        models: (json.data ?? []).map((m) => enrichModel(m)),
      };
    } catch (err) {
      reply.code(502);
      return { error: `couldn't reach ${baseUrl}: ${(err as Error).message}` };
    }
  });

  // Embedding's admin surface lives at /admin/api/global-agents (commit
  // 3 of the global-agent split). The legacy PUT handler is gone -- the
  // Global Services panel is the single source of truth for which
  // model runs embeddings and where its endpoint points.
}
