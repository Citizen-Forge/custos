import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskKind, ComplexityTier } from "./types.js";
import type { OpenAICompatibleInstanceConfig } from "./providers/openai-compatible.js";
import type { Priority } from "./providers/types.js";
import type { PricingConfig } from "./providers/spend-tracker.js";

export interface ProviderEntry {
  /** References either "anthropic" or a key in `openaiCompatibleInstances` (or
   * a key in `providers` when the new shape is in use). */
  provider: string;
  priority: number;
}

export interface AnthropicConfig {
  apiKey?: string;
  /** Max concurrent requests the Anthropic provider will issue.
   * Unset means unlimited -- Anthropic's API tolerates parallel requests
   * and the gateway imposes no additional limit by default. Setting
   * this is rarely needed; think of it as a safety knob, not a tuning
   * surface. */
  maxConcurrent?: number;
}

export interface EmbeddingProviderConfig {
  /** Ollama's *native* API root (no "/v1" suffix) -- embeddings use
   * Ollama's own /api/embeddings, not the OpenAI-compat chat path, so
   * this is intentionally separate from any openaiCompatibleInstances
   * entry even when it happens to point at the same server. */
  baseUrl: string;
  model: string;
}

export interface ComplexityRoutingConfig {
  /** Off by default -- adds a classifier round-trip before every fresh
   * human turn and can change which model handles a conversation
   * mid-stream, so it's opt-in rather than a surprise behavior change. */
  enabled: boolean;
  tiers: Record<ComplexityTier, ProviderEntry[]>;
}

/** How using a provider is paid for. Determines what "unavailable" means
 * and what running out looks like:
 *   "free" — no cost, but usually rate-limited (Gemini free tier, Ollama)
 *   "subscription" — flat fee with a usage window (Anthropic's 5-hour session)
 *   "metered" — pay per token (OpenAI API, Anthropic API key) */
export type CostType = "free" | "subscription" | "metered";

/** A model available under a provider. Multiple models share the provider's
 * base URL, API key, and rate-limit budget. */
export interface ModelDef {
  name: string;
  /** Whether this model is enabled for use. Disabled models stay in the
   * config so re-enabling is a toggle rather than a re-add. */
  enabled: boolean;
  /** Per-model pricing. Only meaningful for metered providers; free and
   * subscription providers have no per-token cost to track. */
  pricing?: PricingConfig;
}

/** Top-level provider abstraction. Replaces the flat
 * `openaiCompatibleInstances` entry-by-entry config with a named provider
 * that can serve multiple models through the same base URL and API key. */
export interface ProviderDef {
  baseUrl: string;
  /** How this provider is paid for. Inferred from `pricing` when not set. */
  costType: CostType;
  models: ModelDef[];
  /** Omit for servers that don't need auth (a local Ollama). */
  apiKey?: string;
  /** Max concurrent requests. 1 forces strict serial. */
  maxConcurrent?: number;
  /** Requests per minute limit. When set, the throttle proactively shapes
   * traffic instead of only reacting to 429s. Set to 10 for Gemini Free. */
  rpmLimit?: number;
  /** Per-instance throttle priority override. */
  priority?: Priority;
  /** Emit late vendor metadata deltas in streaming responses. */
  emitLateMetadataDelta?: boolean;
}

export interface GatewayConfig {
  anthropic?: AnthropicConfig;
  /** Named providers, each with one or more models. The replacement for
   * `openaiCompatibleInstances` — providers share a base URL, API key, and
   * rate-limit budget across all their models, so configuring "Gemini Free"
   * once and enabling several Gemini models underneath is the natural shape.
   * `loadConfig()` auto-migrates from the old flat shape so existing
   * config.json files work unmodified until the admin UI saves the new form. */
  providers?: Record<string, ProviderDef>;
  /** @deprecated Use `providers` instead. Still read during migration so
   * existing configs don't break. */
  openaiCompatibleInstances: Record<string, OpenAICompatibleInstanceConfig>;
  embeddingProvider: EmbeddingProviderConfig;
  tasks: Record<TaskKind, ProviderEntry[]>;
  complexityRouting: ComplexityRoutingConfig;
  /** Shared secret Claude Code sends back as `x-api-key` (the same header
   * it already sends for real Anthropic API-key auth -- Custos ignores the
   * value for upstream purposes since it does its own provider auth
   * server-side, so this repurposes it as Custos's own access control).
   * Gates /v1/messages, /hooks/*, and /memory/search -- the client-facing
   * proxy surface, as opposed to the /admin and /remote paths, which use
   * the session login instead. Fails closed: unset means every request on
   * that surface is rejected, not allowed through -- there's no supported
   * "open" mode. Generate one from the admin UI's Security panel. */
  clientApiKey?: string;
}

const OLLAMA_HOST = "http://localhost:11434";
const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? "data/config.json";

const DEFAULT_CONFIG: GatewayConfig = {
  providers: {
    ollama: {
      baseUrl: `${OLLAMA_HOST}/v1`,
      costType: "free",
      models: [{ name: "qwen2.5:14b-instruct-q4_K_M", enabled: true }],
      maxConcurrent: 1,
    },
    "ollama-fast": {
      baseUrl: `${OLLAMA_HOST}/v1`,
      costType: "free",
      models: [{ name: "qwen2.5:3b-instruct", enabled: true }],
      maxConcurrent: 1,
    },
  },
  openaiCompatibleInstances: {},
  embeddingProvider: { baseUrl: OLLAMA_HOST, model: "nomic-embed-text" },
  tasks: {
    general: [
      { provider: "anthropic", priority: 1 },
      { provider: "ollama", priority: 2 },
    ],
    permissionClassifier: [
      { provider: "ollama-fast", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
    memoryCurator: [
      { provider: "ollama", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
    complexityClassifier: [
      { provider: "ollama-fast", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
  },
  complexityRouting: {
    enabled: false,
    tiers: {
      low: [
        { provider: "ollama-fast", priority: 1 },
        { provider: "anthropic", priority: 2 },
      ],
      medium: [
        { provider: "ollama", priority: 1 },
        { provider: "anthropic", priority: 2 },
      ],
      high: [
        { provider: "anthropic", priority: 1 },
        { provider: "ollama", priority: 2 },
      ],
    },
  },
};

async function readFileConfig(): Promise<Partial<GatewayConfig>> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** File-configured API key (settable via the admin UI) wins once it
 * exists; the env var is only a bootstrap default before that happens. */
export async function getApiKeySource(): Promise<"file" | "env" | "none"> {
  const fileConfig = await readFileConfig();
  if (fileConfig.anthropic?.apiKey) return "file";
  if (process.env.ANTHROPIC_API_KEY) return "env";
  return "none";
}

/** Infers costType from an instance config. Metered when pricing is set,
 * free otherwise -- the old shape had no explicit subscription flag. */
function inferCostType(instance: OpenAICompatibleInstanceConfig): CostType {
  return instance.pricing ? "metered" : "free";
}

/** Migrates an old-style openaiCompatibleInstances entry to a ProviderDef.
 * Each old instance becomes a provider with one enabled model. */
function migrateInstanceToProvider(name: string, instance: OpenAICompatibleInstanceConfig): ProviderDef {
  return {
    baseUrl: instance.baseUrl,
    costType: inferCostType(instance),
    models: [{ name: instance.model, enabled: true, pricing: instance.pricing }],
    apiKey: instance.apiKey,
    maxConcurrent: instance.maxConcurrent,
    priority: instance.priority,
    emitLateMetadataDelta: instance.emitLateMetadataDelta,
  };
}

export async function loadConfig(): Promise<GatewayConfig> {
  const fileConfig = await readFileConfig();

  // Merge the default config with the file config.
  const merged: GatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...fileConfig.anthropic },
    openaiCompatibleInstances: { ...DEFAULT_CONFIG.openaiCompatibleInstances, ...fileConfig.openaiCompatibleInstances },
    embeddingProvider: { ...DEFAULT_CONFIG.embeddingProvider, ...fileConfig.embeddingProvider },
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
    complexityRouting: {
      ...DEFAULT_CONFIG.complexityRouting,
      ...fileConfig.complexityRouting,
      tiers: { ...DEFAULT_CONFIG.complexityRouting.tiers, ...fileConfig.complexityRouting?.tiers },
    },
  };

  // If the file config has the new providers shape, use it directly.
  // Otherwise, migrate from the old openaiCompatibleInstances shape.
  if (fileConfig.providers) {
    merged.providers = {
      ...DEFAULT_CONFIG.providers,
      ...fileConfig.providers,
    };
  } else {
    // Migrate: merge default providers with migrated old instances.
    const migrated: Record<string, ProviderDef> = {};
    // Start with defaults
    for (const [name, instance] of Object.entries(DEFAULT_CONFIG.providers ?? {})) {
      migrated[name] = { ...instance, models: [...instance.models] };
    }
    // Overlay migrated old instances (including file-merged ones)
    for (const [name, instance] of Object.entries(merged.openaiCompatibleInstances)) {
      migrated[name] = migrateInstanceToProvider(name, instance);
    }
    merged.providers = migrated;
  }

  if (!merged.anthropic?.apiKey && process.env.ANTHROPIC_API_KEY) {
    merged.anthropic = { ...merged.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }

  return merged;
}

/** Persists to data/config.json. Only ever writes what the admin UI (or a
 * hand-edited config file) explicitly set -- an env-sourced API key is
 * never written back, so removing the env var still falls back cleanly.
 * Writes the new `providers` shape; the old `openaiCompatibleInstances`
 * field is no longer persisted (loadConfig migrates it on read). */
export async function saveConfig(config: GatewayConfig): Promise<void> {
  const toPersist: Record<string, unknown> = { ...config };
  const anthropic = toPersist.anthropic as { apiKey?: string } | undefined;
  if (anthropic?.apiKey && (await getApiKeySource()) === "env" && anthropic.apiKey === process.env.ANTHROPIC_API_KEY) {
    anthropic.apiKey = undefined;
  }
  // Drop the deprecated field -- we write the new shape going forward.
  delete toPersist.openaiCompatibleInstances;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(toPersist, null, 2), "utf8");
}
