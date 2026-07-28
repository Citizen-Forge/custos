import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { PricingConfig } from "../providers/spend-tracker.js";
import type { Priority } from "../providers/types.js";
import { findInstanceUsages, updateConfig } from "./admin-shared.js";

export function registerProviderRoutes(app: FastifyInstance, runtime: Runtime): void {
  // -- Provider instances (new providers shape) --------------------------

  app.put("/admin/api/providers/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, costType, models, apiKey, maxConcurrent, rpmLimit, priority } = req.body as {
      baseUrl: string;
      costType: "free" | "subscription" | "metered";
      models: { name: string; enabled: boolean; pricing?: PricingConfig | null }[];
      apiKey?: string | null;
      maxConcurrent?: number | null;
      rpmLimit?: number | null;
      priority?: Priority | null;
    };
    if (!baseUrl || !models?.length) {
      reply.code(400);
      return { error: "baseUrl and at least one model are required" };
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
    if (priority !== undefined && priority !== null && priority !== "interactive" && priority !== "background") {
      reply.code(400);
      return { error: `priority must be "interactive", "background", or null (got ${JSON.stringify(priority)})` };
    }
    await updateConfig(runtime, (cfg) => ({
      ...cfg,
      providers: {
        ...cfg.providers,
        [name]: {
          baseUrl,
          costType,
          models: models.map((m) => ({ name: m.name, enabled: m.enabled, ...(m.pricing ? { pricing: m.pricing } : {}) })),
          apiKey: apiKey || undefined,
          maxConcurrent: maxConcurrent ?? undefined,
          rpmLimit: rpmLimit ?? undefined,
          priority: priority ?? undefined,
        },
      },
    }));
    return { ok: true };
  });

  app.delete("/admin/api/providers/:name", async (req, reply) => {
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

  /** Proxied health check: fires a server-side request to the provider's
   * /models endpoint with the configured API key, so the browser doesn't
   * need raw access to stored credentials. */
  app.post("/admin/api/providers/:name/probe", async (req, reply) => {
    const { name } = req.params as { name: string };
    const provider = runtime.config.providers?.[name];
    if (!provider) { reply.code(404); return { error: `provider "${name}" not found` }; }
    try {
      const headers: Record<string, string> = {};
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      return { ok: true, status: res.status, statusText: res.statusText };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Toggle a single model's enabled state without opening the edit form. */
  app.patch("/admin/api/providers/:name/models/:model", async (req, reply) => {
    const { name, model: modelName } = req.params as { name: string; model: string };
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled must be a boolean" };
    }
    const provider = runtime.config.providers?.[name];
    if (!provider) { reply.code(404); return { error: `provider "${name}" not found` }; }
    const decodedModel = decodeURIComponent(modelName);
    const idx = provider.models.findIndex((m) => m.name === decodedModel);
    if (idx === -1) { reply.code(404); return { error: `model "${decodedModel}" not found under provider "${name}"` }; }

    await updateConfig(runtime, (cfg) => {
      const target = cfg.providers?.[name];
      if (!target) return cfg;
      const models = [...target.models];
      models[idx] = { ...models[idx], enabled };
      return { ...cfg, providers: { ...cfg.providers, [name]: { ...target, models } } };
    });
    return { ok: true };
  });

  // -- Legacy instances (backward compat) --------------------------------

  app.put("/admin/api/instances/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, model, apiKey, pricing, maxConcurrent, priority, rpmLimit } = req.body as {
      baseUrl: string;
      model: string;
      apiKey?: string | null;
      pricing?: PricingConfig | null;
      maxConcurrent?: number | null;
      rpmLimit?: number | null;
      priority?: Priority | null;
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
    if (priority !== undefined && priority !== null && priority !== "interactive" && priority !== "background") {
      reply.code(400);
      return { error: `priority must be "interactive", "background", or null (got ${JSON.stringify(priority)})` };
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
          apiKey: apiKey || undefined,
          maxConcurrent: maxConcurrent ?? undefined,
          rpmLimit: rpmLimit ?? undefined,
          priority: priority ?? undefined,
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
  // URLs avoids it landing in access logs.
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
      const json = (await res.json()) as { data?: { id: string; owned_by?: string; created?: number }[] };
      return { models: (json.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by ?? null, created: m.created ?? null })) };
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
