import type { Runtime } from "../runtime.js";
import { saveConfig, type GatewayConfig } from "../config.js";

/** Shared helpers used by the admin route group split across several domain
 * files. Kept here so the route files don't duplicate masking, config
 * updates, or the preset list. */

// Presets for the admin UI's "add instance" form. All of these speak the
// OpenAI chat/completions wire format either natively or via a documented
// compatibility layer -- baseUrl already includes whatever version/path
// prefix that provider needs (matches how OpenAI client SDKs configure
// `base_url`). Tool-calling fidelity varies by provider and hasn't been
// individually verified against each one beyond Ollama.
export const PROVIDER_PRESETS = [
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

export function maskApiKey(key: string): string {
  if (key.length <= 10) return "*".repeat(key.length);
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function findInstanceUsages(config: GatewayConfig, name: string): string[] {
  // Walk only task kinds the runtime actually invokes. Of the four in
  // `TaskKind`:
  //   - general         -- /v1/messages non-pinned path  (live)
  //   - permissionClassifier -- permissions classifier (live)
  //   - memoryCurator   -- memory curator ingest        (live)
  //   - complexityClassifier -- the per-turn classifier; the runtime
  //     branch that called this was dropped in 5643718 when complexity
  //     routing left the schema, so no caller invokes
  //     `router.complete("complexityClassifier", ...)`. An admin path to
  //     populate it (PUT /admin/api/tasks/complexityClassifier) still
  //     exists for power users, so the field is reachable from outside
  //     but unrecoverable from inside the operator flow the admin UI
  //     exposes -- same shape as the dropped complexityRouting.tiers gate.
  //     Walking it here would block a delete the user has no UI to clear.
  const usages: string[] = [];
  for (const [taskKind, entries] of Object.entries(config.tasks)) {
    if (taskKind === "complexityClassifier") continue;
    if (entries.some((e) => e.provider === name)) usages.push(`task:${taskKind}`);
  }
  return usages;
}

export async function updateConfig(runtime: Runtime, mutate: (cfg: GatewayConfig) => GatewayConfig): Promise<GatewayConfig> {
  const next = mutate(runtime.config);
  await saveConfig(next);
  await runtime.reload();
  return runtime.config;
}

export async function describeProviders(runtime: Runtime) {
  const providers = runtime.config.providers;
  if (!providers) return {};
  const entries = await Promise.all(
    Object.entries(providers).map(async ([name, def]) => {
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
