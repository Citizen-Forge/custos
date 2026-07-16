import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../runtime.js";
import { saveConfig, getApiKeySource, type GatewayConfig, type ProviderEntry } from "../config.js";
import type { TaskKind, ComplexityTier } from "../types.js";
import { startOAuthFlow, exchangeCode, type OAuthMode } from "../auth/oauth.js";
import { getOAuthStatus, saveTokens, clearTokens } from "../auth/credentials.js";
import { OAuthFlowTracker } from "../auth/oauth-flow-tracker.js";

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

function buildSetupInstructions() {
  const baseUrl = process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  const envExport = `export ANTHROPIC_BASE_URL=${baseUrl}`;
  const settingsSnippet = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "http", url: `${baseUrl}/hooks/pretooluse`, timeout: 30 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "http", url: `${baseUrl}/hooks/user-prompt-submit`, timeout: 15 }] }],
      PostToolUse: [{ hooks: [{ type: "http", url: `${baseUrl}/hooks/posttooluse`, timeout: 10 }] }],
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

function maskInstances(instances: GatewayConfig["openaiCompatibleInstances"]) {
  return Object.fromEntries(
    Object.entries(instances).map(([name, instance]) => [
      name,
      { baseUrl: instance.baseUrl, model: instance.model, apiKeyConfigured: Boolean(instance.apiKey), apiKeyMasked: instance.apiKey ? maskApiKey(instance.apiKey) : null },
    ]),
  );
}

export function registerAdminRoutes(app: FastifyInstance, runtime: Runtime): void {
  const oauthFlows = new OAuthFlowTracker();

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
      },
      instances: maskInstances(config.openaiCompatibleInstances),
      embeddingProvider: config.embeddingProvider,
      providerNames: ["anthropic", ...Object.keys(config.openaiCompatibleInstances)],
      providerPresets: PROVIDER_PRESETS,
      tasks: config.tasks,
      complexityRouting: config.complexityRouting,
      setup: buildSetupInstructions(),
    };
  });

  // -- Anthropic auth --------------------------------------------------

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

  // -- Model provider instances --------------------------------------------

  app.put("/admin/api/instances/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { baseUrl, model, apiKey } = req.body as { baseUrl: string; model: string; apiKey?: string | null };
    if (!baseUrl || !model) {
      reply.code(400);
      return { error: "baseUrl and model are required" };
    }
    await updateConfig(runtime, (cfg) => ({
      ...cfg,
      openaiCompatibleInstances: { ...cfg.openaiCompatibleInstances, [name]: { baseUrl, model, apiKey: apiKey || undefined } },
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
      const { [name]: _removed, ...rest } = cfg.openaiCompatibleInstances;
      return { ...cfg, openaiCompatibleInstances: rest };
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
      const json = (await res.json()) as { data?: { id: string }[] };
      return { models: (json.data ?? []).map((m) => m.id) };
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
