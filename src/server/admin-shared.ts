import type { Runtime } from "../runtime.js";
import { saveConfig, type GatewayConfig } from "../config.js";
import { primaryPick } from "../pm/agents.js";

/** Shared helpers used by the admin route group split across several domain
 * files. Kept here so the route files don't duplicate masking, config
 * updates, or the preset list. */

// Presets for the admin UI's "add instance" form. All of these speak the
// OpenAI chat/completions wire format either natively or via a documented
// compatibility layer -- baseUrl already includes whatever version/path
// prefix that provider needs (matches how OpenAI client SDKs configure
// `base_url`). Tool-calling fidelity varies by provider and hasn't been
// individually verified against each one beyond Ollama.
//
// `defaults` carries the field values that should land on a newly-added
// provider derived from this preset. The Add form reads from this object
// when the operator picks a preset so they don't have to re-enter
// well-known tuning values; the Edit form leaves them alone (operators
// usually know what they set). Groq specifically defaults to a 32 MB
// request cap because Groq hard-rejects larger bodies with the
// misleading "accumulated images and attachments" message.
export const PROVIDER_PRESETS: Array<{ id: string; label: string; baseUrl: string; needsApiKey: boolean; defaults?: Partial<{ maxRequestBytes: number; rpmLimit: number; maxConcurrent: number; priority: "interactive" | "background" }> }> = [
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsApiKey: false, defaults: { maxConcurrent: 1, priority: "background" } },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsApiKey: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", needsApiKey: true },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsApiKey: true, defaults: { rpmLimit: 10 } },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsApiKey: true, defaults: { maxRequestBytes: 32 * 1024 * 1024 } },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsApiKey: true },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", needsApiKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsApiKey: true },
  { id: "custom", label: "Custom", baseUrl: "", needsApiKey: true },
];

export function maskApiKey(key: string): string {
  if (key.length <= 10) return "*".repeat(key.length);
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function findInstanceUsages(name: string, runtime?: Runtime): Promise<string[]> {
  // After the project/global split (the global-agents module landing
  // alongside this commit), the practical reference surface is
  // agents.json — every agent, project or global, has a fallbackSet
  // whose first entry references the provider we're checking. The
  // config.tasks entries still exist for backwards compatibility with
  // hand-edited configs, but the canonical pickers are the agents
  // themselves, so we walk those.
  //
  // Lazy-import the PM collection so admin-shared stays free of a
  // direct PM dependency at load time (admin routes run before any
  // project agents are listed) and so a future refactor that moves
  // the collection can update this single import. `primaryPick` is the
  // single source of truth for "which provider does this agent dispatch
  // to" post-cleanup, so we test against that rather than reading any
  // stale `providerKey` field off the agent row.
  const { agents, primaryPick } = await import("../pm/agents.js");
  const cfg = runtime?.config;
  const rows = await agents.list();
  const usages: string[] = [];
  for (const row of rows) {
    if (!cfg) continue;
    const pick = primaryPick(row, cfg);
    if (pick?.providerKey !== name) continue;
    if (row.kind === "global") usages.push(`global-agent:${row.systemRole ?? row.role} (${row.name})`);
    else usages.push(`agent:${row.id} ${row.projectId === null ? "shared" : `project ${row.projectId}`}`);
  }
  return usages;
}

/** Resolve an API key from a PUT/PATCH request body against the previously
 *  stored value, preserving the existing key when the caller omits the field
 *  (undefined) or sends an empty string (blank password field on save). Only
 *  update when a non-empty string is provided, and only clear when `null` is
 *  explicitly passed (the admin UI's separate "Clear" button).
 *
 *  All four call sites (provider-routes.ts new-provider + legacy PUT,
 *  anthropic-routes.ts main + legacy PUT) previously duplicated this logic
 *  inline — with a subtle divergence: the Anthropic handlers also checked
 *  `apiKey === ""` while the provider handlers only checked `apiKey === undefined`.
 *  This unified helper applies both guards so all callers behave identically.
 *  See `provider-routes.ts` commit `a179e21` and `anthropic-routes.ts` commit
 *  `51dcb10` for the original inline implementations. */
export function resolveApiKey(
  apiKey: string | null | undefined,
  prevKey: string | undefined,
): string | undefined {
  if (apiKey === undefined || apiKey === "") return prevKey;
  return apiKey || undefined;
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
          embeddingUrl: def.embeddingUrl ?? null,
          costType: def.costType,
          models: def.models,
          pricing: firstEnabled?.pricing ?? null,
          apiKeyConfigured: Boolean(def.apiKey),
          apiKeyMasked: def.apiKey ? maskApiKey(def.apiKey) : null,
          maxConcurrent: def.maxConcurrent ?? null,
          rpmLimit: def.rpmLimit ?? null,
          priority: def.priority ?? null,
          emitLateMetadataDelta: def.emitLateMetadataDelta ?? null,
          maxRequestBytes: def.maxRequestBytes ?? null,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}
