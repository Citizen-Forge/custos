// Wire-format schema for data/config.json. Pure type definitions -- the
// load/save/migration mechanics live in ../config.ts.
import type { TaskKind } from "../types.js";
import type { OpenAICompatibleInstanceConfig } from "../providers/openai-compatible.js";
import type { Priority } from "../providers/types.js";
import type { PricingConfig } from "../providers/spend-tracker.js";

export interface ProviderEntry {
  /** References either "anthropic" or a key in `openaiCompatibleInstances` (or
   * a key in `providers` when the new shape is in use). */
  provider: string;
  priority: number;
}

export interface AnthropicConfig {
  apiKey?: string;
  /** Whether the Anthropic provider is available for dispatch at all.
   *  Defaults to true when unset. Disabling it removes it from the
   *  active provider map entirely on the next reload -- every fallback
   *  set that includes it transparently falls through to its next
   *  entry, the same as if Anthropic were permanently cooling. Config
   *  (API key, throttle settings) is preserved so re-enabling is a
   *  toggle, not a re-entry of credentials. */
  enabled?: boolean;
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

/** A named fallback set: an ordered list of providers (with their
 * selected models) that the GlobalQueue iterates when dispatching a
 * request. The first available provider in the list serves the request.
 * If it fails with a ProviderUnavailableError, the queue falls through
 * to the next provider, and so on. */
export interface FallbackSetDef {
  /** Human-readable name for the operator (e.g. "Complex reasoning"). */
  name: string;
  /** Description explaining when to use this set, written for the Project
   * Manager agent so it can decide which set to assign to each role. */
  description: string;
  /** Ordered list of providers to try. Each entry references a provider
   * name in `providers` (the new shape) or `openaiCompatibleInstances`
   * (legacy). */
  providers: FallbackProviderEntry[];
}

export interface FallbackProviderEntry {
  /** References a key in `providers` or "anthropic". */
  provider: string;
  /** The specific model to use from that provider. */
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
  /** Maximum output tokens this model supports. When set, the provider
   * clamps `max_tokens` in outgoing requests to this value. Operators
   * typically set this per-model because different models from the same
   * provider (e.g. Groq's Qwen 3.6 at 16384 vs Llama 3.1 at 8192) have
   * different per-model caps. Omit to allow any value the caller sends. */
  maxOutputTokens?: number;
  /** Maximum total context (input + output) this model supports. When
   * set, the provider estimates the token count of the serialized request
   * and logs a warning if it exceeds this limit. Unlike `maxOutputTokens`
   * this is purely advisory — the request is still sent because the
   * upstream may enforce its own limit. Different models on the same
   * provider have different context windows (e.g. Groq's Qwen 3.6 at
   * 16384 vs Llama 3.1 at 8192 tokens). Omit to skip the check. */
  maxContextWindow?: number;
}

/** Top-level provider abstraction. Replaces the flat
 * `openaiCompatibleInstances` entry-by-entry config with a named provider
 * that can serve multiple models through the same base URL and API key. */
export interface ProviderDef {
  baseUrl: string;
  /** How this provider is paid for. Inferred from `pricing` when not set. */
  costType: CostType;
  models: ModelDef[];
  /** Whether this provider is available for dispatch at all. Defaults to
   *  true when unset. Distinct from a model's own `enabled` flag -- that
   *  picks which model this provider defaults to; this takes the whole
   *  provider out of the active provider map on the next reload, so
   *  every fallback set that references it transparently falls through
   *  to its next entry. Config is preserved, so re-enabling is a toggle. */
  enabled?: boolean;
  /** Omit for servers that don't need auth (a local Ollama). */
  apiKey?: string;
  /** Max concurrent requests. 1 forces strict serial. */
  maxConcurrent?: number;
  /** Requests per minute limit. When set, the throttle proactively shapes
   * traffic instead of only reacting to 429s. Set to 10 for Gemini Free. */
  rpmLimit?: number;
  /** Cooldown duration to apply when the upstream returns a 429/5xx
   * WITHOUT a usable `Retry-After` header. Without this override, the
   * router falls back to its global `DEFAULT_COOLDOWN_MS = 60_000`,
   * which is wrong-shaped for several real providers:
   *   - Gemini Free quota-exhausted daily caps regenerate on the
   *     order of minutes, not seconds; the 60s default re-attempts
   *     mid-cooldown and keeps the gateway stuck in a 429 loop.
   *   - Ollama on a saturated local box recovers in a few seconds
   *     once its request queue drains; a 60s default is overkill.
   * The Anthropic provider does not need this field: it parses its
   * own Anthropic-specific `anthropic-ratelimit-*-reset` headers,
   * which carry the real reset time. The fallback only applies when
   * neither the upstream `Retry-After` nor the Anthropic-specific
   * headers are present. Unset means use the global 60s default. */
  cooldownFallbackMs?: number;
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
  /** Maximum size, in bytes UTF-8, of a single /chat/completions request
   *  body sent to this upstream. When set, `complete()` measures the
   *  serialized OpenAI request and, if over the cap, replaces the
   *  oldest inline-base64 image parts with a text placeholder until
   *  the body fits. Set this for providers with smaller upstream
   *  limits -- Groq hard-caps the literal wire-body size at 32 MB,
   *  OpenRouter free-tier has varying per-model caps. Leaving unset
   *  keeps every image in full, which is correct for upstream-tolerant
   *  hosts (Anthropic, OpenAI API key, Mistral). The fit is purely
   *  best-effort: a request with no inline images that's still over
   *  the limit fails loud so the upstream's error surfaces to the
   *  operator instead of being silently mangled.
   *
   *  NOTE: this cap is unrelated to Groq's per-model tokens-per-minute
   *  (TPM) limit, which is far smaller (e.g. 12,000 TPM on the
   *  on_demand tier for llama-3.3-70b-versatile) and triggers on
   *  ordinary-sized requests once enough tokens have been sent within
   *  the last 60 seconds. Groq reports the TPM rejection as HTTP 413
   *  with "... on tokens per minute (TPM)" in the body -- the same
   *  status code this cap uses for genuine oversized payloads, but a
   *  different failure the byte-cap logic can't fix by trimming
   *  images. See rate-limit-signature.ts / openai-compatible.ts's
   *  413 handling, which sniffs the body to tell the two apart and
   *  routes the TPM case through the cooldown+fallback path instead. */
  maxRequestBytes?: number;
  /** Pre-emptive truncation threshold, expressed as a fraction of
   *  `maxRequestBytes`. When the serialized request exceeds
   *  `maxRequestBytes * maxRequestBytesWarnRatio`, the oldest
   *  conversation turns are truncated BEFORE the request reaches the
   *  hard cap, keeping the conversation always below the limit.
   *  Default 0.75 (truncate when the request reaches 75% of the cap).
   *  Set to 1 to disable pre-emptive truncation and only strip on
   *  hard cap (the pre-existing behavior). Only meaningful when
   *  `maxRequestBytes` is also set. */
  maxRequestBytesWarnRatio?: number;
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
  /** Ordered fallback sets. A fallback set is a named group of providers
   * with a description, used by the Project Manager to assign model
   * capability tiers to agents. When a request arrives with a fallback
   * set, the GlobalQueue tries each provider in order and falls through
   * to the next if the current one is unavailable (cooldown, rate limit,
   * concurrency cap). This replaces the old task-based routing where
   * each task kind had a hardcoded provider priority list. */
  fallbackSets?: Record<string, FallbackSetDef>;
  /**
   * @deprecated Removed -- custos is no longer a Claude Code proxy and the
   * only requests it handles are its own spawned subprocesses, so the
   * shared-secret client-auth gate is dead weight. The field is read by
   * `pruneStaleFields` and dropped on every restart; the
   * `client-auth-guard.ts` file is preserved as a no-op stub for any
   * leftover registrations. */
  clientApiKey?: string;
  /** Slack bot integration -- see slack.ts. Global (one workspace, one
   *  bot token for the whole gateway); per-project routing lives on
   *  ProjectSettings.slackChannelId instead, since which channel a
   *  project's activity posts to is a per-project concern, not a
   *  global one. */
  slack?: SlackConfig;
}

/** One Slack app/bot token for the whole gateway. Individual agent roles
 *  don't get their own Slack identity (no per-role bot user, no email,
 *  no login) -- outgoing messages use `chat.postMessage`'s per-message
 *  `username`/`icon_emoji` override to visually post as "Product Owner"
 *  etc. while all sharing this one token. Requires the `chat:write.customize`
 *  scope on the bot token; without it Slack silently ignores the override
 *  and every message posts under the app's own fixed name. */
export interface SlackConfig {
  /** xoxb-... bot token from the Slack app's OAuth & Permissions page.
   *  Required scopes: chat:write, chat:write.customize, channels:history
   *  (or groups:history for private channels), channels:read. */
  botToken?: string;
  /** Killswitch for the whole integration, independent of whether a
   *  token is configured -- lets an operator turn Slack off without
   *  discarding the token, and turn it back on without re-entering it.
   *  Defaults to true (enabled) once a token is present; explicitly
   *  false is the only thing that disables it. */
  enabled?: boolean;
}
