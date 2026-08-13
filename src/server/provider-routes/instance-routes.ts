import type { FastifyInstance } from "fastify";
import type { Runtime } from "../../runtime.js";
import type { PricingConfig } from "../../providers/spend-tracker.js";
import type { Priority } from "../../providers/types.js";
import { findInstanceUsages, resolveApiKey, resolveOptionalInt, updateConfig } from "../admin-shared.js";
import { planEmbeddingProbe } from "../../providers/embedding-url.js";
import { getGlobalAgent } from "../../pm/global-agents.js";
import { enrichModel } from "./enrich-model.js";

/** Routes for the current `providers.<name>` shape -- one named provider
 * serving multiple models through the same base URL and API key. See
 * ./legacy-instance-routes.ts for the old `openaiCompatibleInstances`
 * one-instance-one-model shape this superseded. */
export function registerInstanceRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.put("/admin/api/providers/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, costType, models, apiKey, maxConcurrent, rpmLimit, maxRequestBytes, priority, embeddingUrl } = req.body as {
      baseUrl: string;
      costType: "free" | "subscription" | "metered";
      models: { name: string; enabled: boolean; pricing?: PricingConfig | null; maxOutputTokens?: number | null; maxContextWindow?: number | null }[];
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
              ...(m.maxContextWindow !== undefined && m.maxContextWindow !== null ? { maxContextWindow: m.maxContextWindow } : {}),
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

  /** Proxied model scan: fires a server-side request to the provider's
   *  /v1/models endpoint using the STORED API key from config, so the
   *  browser can re-scan models for auth-required providers (Groq, Gemini,
   *  OpenRouter) without exposing their keys to the frontend. Returns the
   *  same enriched shape as POST /admin/api/instances/probe-models but
   *  reads credentials from the saved config rather than from the request
   *  body — intended for the bulk "Re-scan all providers" button. */
  app.post("/admin/api/providers/:name/probe-models", async (req, reply) => {
    const { name } = req.params as { name: string };
    const provider = runtime.config.providers?.[name];
    if (!provider) { reply.code(404); return { error: `provider "${name}" not found` }; }
    try {
      const headers: Record<string, string> = {};
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        reply.code(502);
        return { error: `HTTP ${res.status} from ${provider.baseUrl}/models` };
      }
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      return {
        models: (json.data ?? []).map((m) => enrichModel(m)),
      };
    } catch (err) {
      reply.code(502);
      return { error: `couldn't reach ${provider.baseUrl}: ${(err as Error).message}` };
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
    const { enabled, maxOutputTokens, maxContextWindow } = req.body as { enabled?: boolean; maxOutputTokens?: number | null; maxContextWindow?: number | null };
    if (enabled !== undefined && typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled must be a boolean" };
    }
    if (maxOutputTokens !== undefined && maxOutputTokens !== null &&
        (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
      reply.code(400);
      return { error: "maxOutputTokens must be a positive integer (or null for unlimited)" };
    }
    if (maxContextWindow !== undefined && maxContextWindow !== null &&
        (!Number.isInteger(maxContextWindow) || maxContextWindow < 1)) {
      reply.code(400);
      return { error: "maxContextWindow must be a positive integer (or null for unlimited)" };
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
      if (maxContextWindow !== undefined) updated.maxContextWindow = maxContextWindow ?? undefined;
      models[idx] = updated;
      return { ...cfg, providers: { ...cfg.providers, [name]: { ...target, models } } };
    });
    return { ok: true };
  });

  // Lightweight toggle -- distinct from the PUT above, which requires the
  // full provider payload (baseUrl, models, ...) and is what the Edit
  // form's Save button uses. This exists so the admin UI's inline
  // enable/disable switch doesn't need to round-trip the entire provider
  // shape just to flip one field.
  app.patch("/admin/api/providers/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { enabled } = req.body as { enabled?: boolean };
    if (enabled === undefined) {
      reply.code(400);
      return { error: "enabled is required" };
    }
    if (typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled must be a boolean" };
    }
    if (!runtime.config.providers?.[name]) {
      reply.code(404);
      return { error: `provider "${name}" not found` };
    }
    await updateConfig(runtime, (cfg) => {
      const target = cfg.providers?.[name];
      if (!target) return cfg;
      return { ...cfg, providers: { ...cfg.providers, [name]: { ...target, enabled } } };
    });
    return { ok: true };
  });

}
