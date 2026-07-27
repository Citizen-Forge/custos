import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Runtime } from "../runtime.js";
import { saveConfig, getApiKeySource, type GatewayConfig, type ProviderEntry } from "../config.js";
import type { TaskKind, ComplexityTier } from "../types.js";
import { startOAuthFlow, exchangeCode, type OAuthMode } from "../auth/oauth.js";
import { getOAuthStatus, saveTokens, clearTokens } from "../auth/credentials.js";
import { OAuthFlowTracker } from "../auth/oauth-flow-tracker.js";
import type { PricingConfig } from "../providers/spend-tracker.js";
import type { Priority } from "../providers/types.js";

const TASK_KINDS: TaskKind[] = ["general", "permissionClassifier", "memoryCurator", "complexityClassifier"];
const COMPLEXITY_TIERS: ComplexityTier[] = ["low", "medium", "high"];

// Presets for the admin UI's "add instance" form. All of these speak the
// OpenAI chat/completions wire format either natively or via a documented
// compatibility layer -- baseUrl already includes whatever version/path
// prefix that provider needs (matches how OpenAI client SDKs configure
// `base_url`). Tool-calling fidelity varies by provider and hasn't been
// individually verified against each one beyond Ollama.
const PROVIDER_PRESETS = [
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsApiKey: false },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsApiKey: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", needsApiKey: true },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsApiKey: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsApiKey: true },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsApiKey: true },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", needsApiKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsApiKey: true },
  { id: "custom", label: "Custom", baseUrl: "", needsApiKey: true },
];

function maskApiKey(key: string): string {
  if (key.length <= 10) return "*".repeat(key.length);
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function buildSetupInstructions(clientApiKey?: string) {
  // `||` not `??`: docker-compose's `${GATEWAY_PUBLIC_URL:-}` passes an
  // empty string, not an absent var, when unset (same footgun as
  // ADMIN_PASSWORD -- see admin-session.ts).
  const baseUrl = process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.PORT ?? 8787}`;
  const envLines = [`export ANTHROPIC_BASE_URL=${baseUrl}`];
  if (clientApiKey) envLines.push(`export ANTHROPIC_API_KEY=${clientApiKey}`);
  const envExport = envLines.join("\n");

  const hookEntry = (path: string, timeout: number) => ({
    hooks: [{ type: "http", url: `${baseUrl}${path}`, timeout, ...(clientApiKey ? { headers: { "x-api-key": clientApiKey } } : {}) }],
  });
  const settingsSnippet = {
    hooks: {
      PreToolUse: [hookEntry("/hooks/pretooluse", 30)],
      UserPromptSubmit: [hookEntry("/hooks/user-prompt-submit", 15)],
      PostToolUse: [hookEntry("/hooks/posttooluse", 10)],
    },
  };
  return { baseUrl, envExport, hooksJson: JSON.stringify(settingsSnippet, null, 2) };
}

function findInstanceUsages(config: GatewayConfig, name: string): string[] {
  const usages: string[] = [];
  for (const [taskKind, entries] of Object.entries(config.tasks)) {
    if (entries.some((e) => e.provider === name)) usages.push(`task:${taskKind}`);
  }
  for (const [tier, entries] of Object.entries(config.complexityRouting.tiers)) {
    if (entries.some((e) => e.provider === name)) usages.push(`complexityTier:${tier}`);
  }
  return usages;
}

async function updateConfig(runtime: Runtime, mutate: (cfg: GatewayConfig) => GatewayConfig): Promise<GatewayConfig> {
  const next = mutate(runtime.config);
  await saveConfig(next);
  await runtime.reload();
  return runtime.config;
}

async function describeProviders(runtime: Runtime) {
  const providers = runtime.config.providers;
  if (!providers) return {};
  const entries = await Promise.all(
    Object.entries(providers).map(async ([name, def]) => {
      // Expose pricing from the first enabled model so the admin UI's
      // Edit form can pre-fill its pricing fields (pricing is per-model
      // in the new shape but most providers have uniform pricing).
      const firstEnabled = def.models.find((m) => m.enabled) ?? def.models[0];
      return [
        name,
        {
          baseUrl: def.baseUrl,
          costType: def.costType,
          models: def.models,
          pricing: firstEnabled?.pricing ?? null,
          apiKeyConfigured: Boolean(def.apiKey),
          apiKeyMasked: def.apiKey ? maskApiKey(def.apiKey) : null,
          maxConcurrent: def.maxConcurrent ?? null,
          rpmLimit: def.rpmLimit ?? null,
          priority: def.priority ?? null,
          emitLateMetadataDelta: def.emitLateMetadataDelta ?? null,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function registerAdminRoutes(app: FastifyInstance, runtime: Runtime): void {
  const oauthFlows = new OAuthFlowTracker();

  app.get("/admin/api/version", async () => {
    const { getCommitHash } = await import("../version.js");
    return { commit: await getCommitHash() };
  });

  app.get("/admin", async (_req, reply) => {
    const html = await readFile(join(process.cwd(), "public", "admin.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(html);
  });

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
  });  // -- Client API key (gates /v1/messages, /hooks/*, /memory/search) ------

  app.post("/admin/api/client-key/generate", async () => {
    const key = `custos-${randomBytes(24).toString("base64url")}`;
    await updateConfig(runtime, (cfg) => ({ ...cfg, clientApiKey: key }));
    return { clientApiKey: key };
  });

  // -- Runtime stats ------------------------------------------------------
  // Live snapshot of per-provider throttle queue depth + router cooldown
  // state. Consumed by the admin UI for an at-a-glance saturation view
  // and by external monitoring (Prometheus scrape, custom dashboard).
  // Admin-authed via the same session cookie as the rest of /admin/api/*.
  app.get("/admin/api/runtime/stats", async () => {
    return runtime.stats();
  });

  app.post("/admin/api/client-key/clear", async () => {
    await updateConfig(runtime, (cfg) => ({ ...cfg, clientApiKey: undefined }));
    return { ok: true };
  });

  // -- Anthropic auth --------------------------------------------------

  app.put("/admin/api/anthropic", async (req, reply) => {
    const { apiKey, maxConcurrent, rpmLimit } = req.body as { apiKey?: string | null; maxConcurrent?: number | null; rpmLimit?: number | null };
    if (maxConcurrent !== undefined && maxConcurrent !== null && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)) {
      reply.code(400);
      return { error: "maxConcurrent must be a positive integer (or null for unlimited)" };
    }
    if (rpmLimit !== undefined && rpmLimit !== null && (!Number.isInteger(rpmLimit) || rpmLimit < 1)) {
      reply.code(400);
      return { error: "rpmLimit must be a positive integer (or null for unlimited)" };
    }
    const config = await updateConfig(runtime, (cfg) => ({
      ...cfg,
      anthropic: {
        ...cfg.anthropic,
        ...(apiKey !== undefined ? { apiKey: apiKey || undefined } : {}),
        ...(maxConcurrent !== undefined ? { maxConcurrent: maxConcurrent ?? undefined } : {}),
        ...(rpmLimit !== undefined ? { rpmLimit: rpmLimit ?? undefined } : {}),
      },
    }));
    const result: Record<string, unknown> = {};
    if (apiKey !== undefined) {
      result.apiKeySource = await getApiKeySource();
      result.apiKeyMasked = config.anthropic?.apiKey ? maskApiKey(config.anthropic.apiKey) : null;
    }
    return { ok: true, ...result };
  });

  // Keep the old endpoint for backward compat.
  app.put("/admin/api/anthropic-key", async (req, reply) => {
    const { apiKey } = req.body as { apiKey: string | null };
    const config = await updateConfig(runtime, (cfg) => ({
      ...cfg,
      anthropic: { ...cfg.anthropic, apiKey: apiKey || undefined },
    }));
    return { apiKeySource: await getApiKeySource(), apiKeyMasked: config.anthropic?.apiKey ? maskApiKey(config.anthropic.apiKey) : null };
  });

  app.post("/admin/api/oauth/start", async (req, reply) => {
    const { mode } = req.body as { mode: OAuthMode };
    if (mode !== "max" && mode !== "console") {
      reply.code(400);
      return { error: "mode must be \"max\" or \"console\"" };
    }
    const flow = startOAuthFlow(mode);
    const flowId = oauthFlows.create(flow);
    return { flowId, authorizationUrl: flow.authorizationUrl };
  });

  app.post("/admin/api/oauth/complete", async (req, reply) => {
    const { flowId, code } = req.body as { flowId: string; code: string };
    const flow = oauthFlows.consume(flowId);
    if (!flow) {
      reply.code(400);
      return { error: "OAuth flow not found or expired -- start over" };
    }
    try {
      const tokens = await exchangeCode(code, flow);
      await saveTokens(tokens);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    return { ok: true, oauth: await getOAuthStatus() };
  });

  app.post("/admin/api/oauth/disconnect", async () => {
    await clearTokens();
    return { ok: true, oauth: await getOAuthStatus() };
  });

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
    const usages = findInstanceUsages(runtime.config, name);
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
   * need raw access to stored credentials. Returns the HTTP status on
   * success or the error message on failure. */
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
    // Validate the provider and model exist.
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

  // Keep old instances endpoint working for backward compat.
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
    // Write to the new providers shape, migrating from old-style entry.
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
    const usages = findInstanceUsages(runtime.config, name);
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
      // Return the full model objects so the admin UI can display
      // metadata (owned_by, created) alongside each model ID.
      const json = (await res.json()) as { data?: { id: string; owned_by?: string; created?: number }[] };
      return { models: (json.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by ?? null, created: m.created ?? null })) };
    } catch (err) {
      reply.code(502);
      return { error: `couldn't reach ${baseUrl}: ${(err as Error).message}` };
    }
  });

  app.put("/admin/api/embedding-provider", async (req, reply) => {
    const { baseUrl, model } = req.body as { baseUrl: string; model: string };
    if (!baseUrl || !model) {
      reply.code(400);
      return { error: "baseUrl and model are required" };
    }
    await updateConfig(runtime, (cfg) => ({ ...cfg, embeddingProvider: { baseUrl, model } }));
    return { ok: true };
  });

  // -- Task priorities & complexity routing -------------------------------

  app.put("/admin/api/tasks/:taskKind", async (req, reply) => {
    const { taskKind } = req.params as { taskKind: string };
    if (!TASK_KINDS.includes(taskKind as TaskKind)) {
      reply.code(400);
      return { error: `unknown task "${taskKind}"` };
    }
    const { entries } = req.body as { entries: ProviderEntry[] };
    await updateConfig(runtime, (cfg) => ({ ...cfg, tasks: { ...cfg.tasks, [taskKind]: entries } }));
    return { ok: true };
  });

  app.put("/admin/api/complexity-routing", async (req, reply) => {
    const body = req.body as { enabled: boolean; tiers: Record<ComplexityTier, ProviderEntry[]> };
    for (const tier of COMPLEXITY_TIERS) {
      if (!body.tiers[tier]) {
        reply.code(400);
        return { error: `missing tier "${tier}"` };
      }
    }
    await updateConfig(runtime, (cfg) => ({ ...cfg, complexityRouting: { enabled: body.enabled, tiers: body.tiers } }));
    return { ok: true };
  });
}
