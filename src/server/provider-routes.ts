import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import type { PricingConfig } from "../providers/spend-tracker.js";
import type { Priority } from "../providers/types.js";
import { findInstanceUsages, resolveApiKey, resolveOptionalInt, updateConfig } from "./admin-shared.js";
import { planEmbeddingProbe, resolveEmbeddingHost } from "../providers/embedding-url.js";
import { getGlobalAgent } from "../pm/global-agents.js";

export function registerProviderRoutes(app: FastifyInstance, runtime: Runtime): void {
  // -- Provider instances (new providers shape) --------------------------

  app.put("/admin/api/providers/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, costType, models, apiKey, maxConcurrent, rpmLimit, maxRequestBytes, priority, embeddingUrl } = req.body as {
      baseUrl: string;
      costType: "free" | "subscription" | "metered";
      models: { name: string; enabled: boolean; pricing?: PricingConfig | null; maxOutputTokens?: number | null }[];
      apiKey?: string | null;
      maxConcurrent?: number | null;
      rpmLimit?: number | null;
      maxRequestBytes?: number | null;
      priority?: Priority | null;
      embeddingUrl?: string | null;
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
        // Lightweight parse signal: URL constructor catches obvious typos.
        // The Admin UI also has a "Probe" button so a user can confirm
        // reachability before Save clicks take effect.
        new URL(embeddingUrl);
      } catch {
        reply.code(400);
        return { error: `embeddingUrl "${embeddingUrl}" is not a valid URL` };
      }
    }
    await updateConfig(runtime, (cfg) => {
      return {
        ...cfg,
        providers: {
          ...cfg.providers,
          [name]: {
            baseUrl,
            costType,
            models: models.map((m) => ({
              name: m.name,
              enabled: m.enabled,
              ...(m.pricing ? { pricing: m.pricing } : {}),
              ...(m.maxOutputTokens !== undefined && m.maxOutputTokens !== null ? { maxOutputTokens: m.maxOutputTokens } : {}),
            })),
            apiKey: resolveApiKey(apiKey, cfg.providers?.[name]?.apiKey),
            maxConcurrent: resolveOptionalInt(maxConcurrent, cfg.providers?.[name]?.maxConcurrent),
            rpmLimit: resolveOptionalInt(rpmLimit, cfg.providers?.[name]?.rpmLimit),
            maxRequestBytes: resolveOptionalInt(maxRequestBytes, cfg.providers?.[name]?.maxRequestBytes),
            priority: priority ?? undefined,
            embeddingUrl: embeddingUrl ? embeddingUrl : undefined,
          },
        },
      };
    });
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

  /** Proxied embeddings health check. Reads what the runtime WOULD use
   *  for `runtime.embedding.baseUrl` for this provider (with the current
   *  embeddings global agent's per-agent override applied on top), then
   *  POSTs a trivial body to the candidate path the heuristic picked
   *  and reports the upstream's response. Returns the resolution plan
   *  alongside the live result so a "✓ responding" UI tick matches
   *  what the runtime will actually do on the next refreshEmbedding. */
  app.post("/admin/api/providers/:name/probe-embeddings", async (req, reply) => {
    const { name } = req.params as { name: string };
    const provider = runtime.config.providers?.[name];
    if (!provider) { reply.code(404); return { error: `provider "${name}" not found` }; }
    const embeddingAgent = await getGlobalAgent("embeddings");
    const plan = planEmbeddingProbe({
      agentOverride: embeddingAgent?.embeddingBaseUrl,
      providerEmbeddingUrl: provider.embeddingUrl,
      providerBaseUrl: provider.baseUrl,
    });
    // Pick a model to probe with -- first enabled model, else just the
    // provider name as a generic read; an Ollama server is happy with a
    // model name it has loaded, but our heuristic shouldn't 4xx on a
    // name mismatch (that's a runtime concern, not a config-concern).
    const probeModel = provider.models.find((m) => m.enabled)?.name ?? provider.models[0]?.name ?? "test";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const tries: Array<{
      path: string;
      shape: "ollama" | "openai-compat";
      status: number;
      statusText: string;
      ok: boolean;
    }> = [];
    for (const candidate of plan.candidates) {
      const url = `${plan.host}${candidate.path}`;
      const body = candidate.shape === "ollama"
        ? JSON.stringify({ model: probeModel, prompt: "ping" })
        : JSON.stringify({ model: probeModel, input: "ping" });
      try {
        const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8_000) });
        tries.push({
          path: candidate.path,
          shape: candidate.shape,
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
        });
      } catch (err) {
        tries.push({
          path: candidate.path,
          shape: candidate.shape,
          status: 0,
          statusText: (err as Error).message,
          ok: false,
        });
      }
    }
    const success = tries.find((t) => t.ok);
    return { plan, host: plan.host, tried: tries, ok: Boolean(success), picked: success?.path ?? null };
  });

  /** Toggle a single model's enabled state or update maxOutputTokens
   *  without opening the edit form. Accepts both fields in one call
   *  so the admin UI can fire one PATCH when the operator clicks either
   *  the enable checkbox or edits the maxOutputTokens input on a model
   *  sub-row. Fields not present in the body are left unchanged. */
  app.patch("/admin/api/providers/:name/models/:model", async (req, reply) => {
    const { name, model: modelName } = req.params as { name: string; model: string };
    const { enabled, maxOutputTokens } = req.body as { enabled?: boolean; maxOutputTokens?: number | null };
    if (enabled !== undefined && typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled must be a boolean" };
    }
    if (maxOutputTokens !== undefined && maxOutputTokens !== null &&
        (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
      reply.code(400);
      return { error: "maxOutputTokens must be a positive integer (or null for unlimited)" };
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
      const updated = { ...models[idx] };
      if (enabled !== undefined) updated.enabled = enabled;
      if (maxOutputTokens !== undefined) updated.maxOutputTokens = maxOutputTokens ?? undefined;
      models[idx] = updated;
      return { ...cfg, providers: { ...cfg.providers, [name]: { ...target, models } } };
    });
    return { ok: true };
  });

  // -- Legacy instances (backward compat) --------------------------------

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
