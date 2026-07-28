import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskKind } from "./types.js";
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
  /** Requests per minute limit for the Anthropic provider. When set, the
   * throttle proactively shapes traffic instead of only reacting to 429s. */
  rpmLimit?: number;
}

export interface EmbeddingProviderConfig {
  /** Ollama's *native* API root (no "/v1" suffix) -- embeddings use
   * Ollama's own /api/embeddings, not the OpenAI-compat chat path, so
   * this is intentionally separate from any openaiCompatibleInstances
   * entry even when it happens to point at the same server. */
  baseUrl: string;
  model: string;
}

/** @deprecated Embeddings now live on the global agent with
 *  `systemRole: "embeddings"` (see pm/global-agents.ts). Kept as a
 *  no-op alias here so older callers keep type-checking; the load path
 *  drops the field on read through `pruneStaleFields` and runtime
 *  derives `EmbeddingConfig` from the global agent at every reload. */
export type EmbeddingConfig = EmbeddingProviderConfig;

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
  /** Explicit embeddings-endpoint override (full URL). When set, the
   *  runtime uses it for `runtime.embedding.baseUrl` instead of the
   *  port-11434 / hostname-`ollama` heuristic. Use this for providers
   *  that don't follow either default convention — e.g. an OpenAI-
   *  compat provider whose embeddings live at `/v1/embeddings` rather
   *  than Ollama's native `/api/embeddings`, or a remote embedding
   *  service colocated on a non-default port. The per-agent override on
   *  the global embeddings agent's `embeddingBaseUrl` field still wins
   *  over this when both are present. */
  embeddingUrl?: string;
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
  /** @deprecated Embeddings are owned by the global agent with
   *  `systemRole: "embeddings"` (pm/global-agents.ts). The field is still
   *  accepted by the type for backwards compatibility — `pruneStaleFields`
   *  strips it on read so legacy on-disk configs converge to canonical
   *  shape at the next restart; `runtime.embedding` is derived from the
   *  global agent instead of reading this property directly. */
  embeddingProvider?: EmbeddingProviderConfig;
  tasks: Record<TaskKind, ProviderEntry[]>;
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

/** Folds the legacy `openaiCompatibleInstances` shape into the canonical
 * `providers` shape, in-place on `fileConfig`. Runs BEFORE pruneStaleFields
 * so the prune can drop the legacy field without losing user data: legacy
 * entries that haven't been migrated to the new shape are migrated here,
 * the in-memory `fileConfig.providers` carries them through the merge,
 * and the prune then zeros the legacy field on disk-equivalent for the
 * rest of the load. */
function migrateLegacyShape(fileConfig: Partial<GatewayConfig>): void {
  if (fileConfig.providers || !fileConfig.openaiCompatibleInstances) return;
  const migrated: Record<string, ProviderDef> = {};
  for (const [name, instance] of Object.entries(fileConfig.openaiCompatibleInstances)) {
    migrated[name] = migrateInstanceToProvider(name, instance);
  }
  fileConfig.providers = migrated;
}

/** Strips documented-deprecated fields from a freshly-read `fileConfig`
 * before the merge step so they never reach the in-memory `GatewayConfig`.
 * Today `saveConfig` already drops `openaiCompatibleInstances` on write,
 * but a file that has never been saved through the new admin UI keeps
 * that field plus any other now-defunct entries indefinitely. Pruning at
 * read means the on-disk file converges to canonical shape on every
 * restart, and a future deprecation is a one-line addition here.
 *
 * PRUNED:
 *   - `complexityRouting` — schema dropped in 5643718; no runtime caller;
 *     no admin UI mutates it. Hard drop.
 *   - `openaiCompatibleInstances` — superseded by `providers.<name>`.
 *     `migrateLegacyShape` above folds legacy entries into `providers`
 *     before this drop, so user data is preserved through the prune.
 *   - `tasks.complexityClassifier` (nested under `tasks`) — `TaskKind`
 *     no longer includes this member (dropped in this commit's type
 *     tightening), so `PUT /admin/api/tasks/complexityClassifier` now
 *     hard-400s and no admin path reaches the field. Prior on-disk
 *     entries silently phase out on the next restart; auto-pruning here
 *     lines up with the type tightening.
 *
 * KEPT (intentionally not pruned, with a documented path to future-proofing):
 *   - `clientApiKey` — `client-auth-guard.ts` reads it and fails closed on
 *     missing (every /v1/messages 401s). `headless-settings.ts` uses it for
 *     hook `x-api-key`, and `turn-runner.ts` propagates it as ANTHROPIC_API_KEY
 *     to spawned claude subprocesses. There is no `CUSTOS_CLIENT_API_KEY`
 *     env var fallback, so a future prune is a real migration -- needs an
 *     alternate auth path first.
 */
function pruneStaleFields(fileConfig: Partial<GatewayConfig>): void {
  // JSON.parse can include fields the GatewayConfig type doesn't list
  // (most commonly: previously-deprecated shapes whose schema entries
  // were dropped, e.g. complexityRouting after 5643718). Cast to a
  // record so we can still sweep those keys without TS2339.
  const stale = fileConfig as Partial<GatewayConfig> & Record<string, unknown>;
  delete stale.complexityRouting;
  delete stale.openaiCompatibleInstances;
  // Embeddings moved to a global agent (commit 2 of the global-agent
  // split). The on-disk field stopped being read by runtime after that
  // commit landed; keeping the type optional lets legacy config.json
  // files load without TS errors, but the value is dead on disk and a
  // user who wants to keep their saved embedding config should move
  // the same model/baseUrl into the embeddings global agent via the
  // admin UI's Global Services panel.
  delete stale.embeddingProvider;
  // Same approach for the nested legacy task-kind key -- `fileConfig.tasks`
  // is typed as `Record<TaskKind, …>` and `complexityClassifier` doesn't
  // exist there any more; the cast lets the sweep keep its invariant that
  // the on-disk file converges to canonical shape.
  const tasks = fileConfig.tasks as Record<string, unknown> | undefined;
  delete tasks?.complexityClassifier;
}

export async function loadConfig(): Promise<GatewayConfig> {
  const fileConfig = await readFileConfig();
  // Order matters: migrate legacy entries into canonical `providers`
  // BEFORE dropping the legacy field, so the prune doesn't lose user
  // data. Both helpers are no-ops on already-canonical files so the cost
  // is negligible on every restart, not just on migration events.
  migrateLegacyShape(fileConfig);
  pruneStaleFields(fileConfig);

  // Merge the default config with the file config.
  const merged: GatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...fileConfig.anthropic },
    openaiCompatibleInstances: { ...DEFAULT_CONFIG.openaiCompatibleInstances, ...fileConfig.openaiCompatibleInstances },
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
  };

  // fileConfig.providers is populated either by user-set or by
  // migrateLegacyShape above. Defaults overlay on top.
  merged.providers = { ...DEFAULT_CONFIG.providers, ...(fileConfig.providers ?? {}) };

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
