import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRouter, type AvailabilityListener } from "./providers/router.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { ThrottledProvider, type ThrottleStats } from "./providers/throttle.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";
import { getGlobalAgent } from "./pm/global-agents.js";
import { resolveEmbeddingHost } from "./providers/embedding-url.js";

/** Per-provider runtime stats, used by the admin endpoint, the periodic
 * stats logger, and the threshold-alert monitor. Extends ThrottleStats
 * with the router-level cooldown overlay so callers see "why is this
 * provider skipped" alongside the throttle queue depth in one shape. */
export interface ProviderRuntimeStats extends ThrottleStats {
  /** ms epoch when the router cooldown expires; undefined when the
   *  provider is currently available. */
  cooldownUntil?: number;
}

/** Runtime-wide stats snapshot. Returned by `Runtime.stats()` and
 *  consumed by the admin endpoint, the periodic logger, and the
 *  threshold monitor. Always a fresh object so callers never see
 *  stale data through a shared reference. */
export interface RuntimeStats {
  providers: Record<string, ProviderRuntimeStats>;
  /** ms epoch at which the snapshot was taken -- useful when log lines
   *  and HTTP responses are correlated after the fact. */
  timestamp: number;
}

/**
 * Holds the currently-active config-derived objects (providers, router,
 * embedding target) and rebuilds them on demand. Routes and the curator
 * read through this rather than capturing router/embedding once at
 * startup, so an admin-UI config change takes effect on the next request
 * instead of requiring a container restart. spendTracker is NOT rebuilt on
 * reload -- it's a long-lived ledger, not config-derived.
 */
export class Runtime {
  config!: GatewayConfig;
  router!: ProviderRouter;
  /** Embedding target, now derived from the global embeddings agent
   *  (systemRole: "embeddings") rather than from a deprecated top-level
   *  `config.embeddingProvider` field. Null when no embeddings global
   *  agent is configured -- callers handle that by skipping embedding-
   *  dependent work rather than crashing. */
  embedding: EmbeddingConfig | null = null;
  readonly spendTracker = new SpendTracker();
  private availabilityListener: AvailabilityListener | null = null;
  /** ThrottledProviders currently wired into this runtime. On reload we
   * abortAll() each one so a config edit doesn't leave old in-flight
   * requests continuing to do work against a runtime that's already
   * switched shape underneath them. */
  private readonly liveThrottles = new Set<ThrottledProvider>();

  /** Survives config reloads, unlike the router it's attached to. */
  setAvailabilityListener(listener: AvailabilityListener): void {
    this.availabilityListener = listener;
    this.router?.setAvailabilityListener(listener);
  }

  /** Per-provider stats snapshot aggregating every live throttle plus
   *  the router's cooldown state. Used by the admin stats endpoint,
   *  the periodic stats logger, and the sustained-threshold alert
   *  monitor. Returns a fresh object on every call -- no caching --
   *  so callers always see live data. Guards against being called
   *  before the first `reload()` completes (defensive: the definite
   *  assignment assertion on `router!` means a premature call would
   *  throw a TypeError instead of returning empty data). */
  stats(): RuntimeStats {
    if (!this.router) {
      return { providers: {}, timestamp: Date.now() };
    }
    const providers: Record<string, ProviderRuntimeStats> = {};
    for (const t of this.liveThrottles) {
      providers[t.name] = t.stats();
    }
    // Overlay router cooldown info onto each throttled provider's
    // stats. Non-throttled providers that happen to be on cooldown
    // (e.g. Anthropic with no maxConcurrent configured) won't show up
    // here -- the cooldown map is read-only on this path, so existing
    // throttle stats are never mutated to lose data.
    const cooldowns = this.router.cooldowns();
    for (const [name, until] of Object.entries(cooldowns)) {
      const existing = providers[name];
      if (existing) existing.cooldownUntil = until;
    }
    return { providers, timestamp: Date.now() };
  }

  async reload(): Promise<void> {
    const config = await loadConfig();

    // Wrap each provider in a ThrottledProvider when its config sets a
    // max-concurrent limit (the canonical case is local Ollama on
    // consumer hardware where two simultaneous inference jobs don't get
    // done faster and may thrash VRAM). Wrapping happens once here, so
    // every call site -- router.complete, future direct invocations --
    // sees the same throttle without each caller having to remember.
    // Each ThrottledProvider has its own slot counter and its own FIFO
    // queue, so a saturated ollama does not hold up a free anthropic
    // upstream -- provider-awareness comes for free from the per-instance
    // wrapping, with no router changes needed.
    const providers: Record<string, Provider> = {};
    const newThrottles = new Set<ThrottledProvider>();
    const anthropicInner = new AnthropicProvider({ apiKey: config.anthropic?.apiKey });
    if (config.anthropic?.maxConcurrent) {
      const t = new ThrottledProvider(anthropicInner, { maxConcurrent: config.anthropic.maxConcurrent });
      providers.anthropic = t;
      newThrottles.add(t);
    } else {
      providers.anthropic = anthropicInner;
    }
    // Wire up providers from the new `providers` config shape. Each
    // provider gets its own ThrottledProvider (handling both concurrency and
    // rate limiting) ONLY when maxConcurrent or rpmLimit is explicitly set.
    // Providers without either stay unlimited (no ThrottledProvider wrapper)
    // to preserve the pre-Phase-1 default for Anthropic and similar.
    for (const [name, providerDef] of Object.entries(config.providers ?? {})) {
      const defaultModel = providerDef.models.find((m) => m.enabled) ?? providerDef.models[0];
      if (!defaultModel) continue;
      // Build an OpenAICompatibleInstanceConfig from the provider def.
      const instanceConfig = {
        baseUrl: providerDef.baseUrl,
        model: defaultModel.name,
        apiKey: providerDef.apiKey,
        pricing: defaultModel.pricing,
        maxConcurrent: providerDef.maxConcurrent,
        rpmLimit: providerDef.rpmLimit,
        priority: providerDef.priority,
        emitLateMetadataDelta: providerDef.emitLateMetadataDelta,
      };
      const inner = new OpenAICompatibleProvider(name, instanceConfig);
      if (providerDef.maxConcurrent || providerDef.rpmLimit) {
        const opts: { maxConcurrent: number; rpmLimit?: number } = {
          maxConcurrent: providerDef.maxConcurrent ?? 1,
        };
        if (providerDef.rpmLimit) opts.rpmLimit = providerDef.rpmLimit;
        const t = new ThrottledProvider(inner, opts);
        providers[name] = t;
        newThrottles.add(t);
      } else {
        providers[name] = inner;
      }
    }
    // Also wire up deprecated openaiCompatibleInstances for backward compat.
    for (const [name, instance] of Object.entries(config.openaiCompatibleInstances)) {
      if (providers[name]) continue; // already wired from new shape
      const inner = new OpenAICompatibleProvider(name, instance);
      if (instance.maxConcurrent || instance.rpmLimit) {
        const opts: { maxConcurrent: number; rpmLimit?: number } = {
          maxConcurrent: instance.maxConcurrent ?? 1,
        };
        if (instance.rpmLimit) opts.rpmLimit = instance.rpmLimit;
        const t = new ThrottledProvider(inner, opts);
        providers[name] = t;
        newThrottles.add(t);
      } else {
        providers[name] = inner;
      }
    }

    // Drop the old throttles BEFORE swapping in the new router so any
    // in-flight inner fetches stop promptly instead of silently
    // continuing to draw upstream capacity against a runtime that's
    // already been replaced. The router itself is rebuilt below;
    // keeping references to old throttles in `liveThrottles` matters
    // because each ThrottledProvider holds its own in-flight
    // AbortControllers and they need an explicit abort() per the
    // semantics in throttle.ts.
    for (const old of this.liveThrottles) {
      old.abortAll("runtime reload: config changed");
    }

    this.config = config;
    this.router = new ProviderRouter(providers, config, this.spendTracker);
    this.liveThrottles.clear();
    for (const t of newThrottles) this.liveThrottles.add(t);
    // Re-attached on every reload: the router is rebuilt from config, but
    // the model registry that learns from it is long-lived.
    if (this.availabilityListener) this.router.setAvailabilityListener(this.availabilityListener);
    // Embeddings derive from the global agent with systemRole
    // "embeddings" and need to refresh on every config reload — the
    // agent's `providerKey` could now point at a different configured
    // provider after the user adds a new one in the admin UI.
    await this.refreshEmbedding();
  }

  /** Reads the embeddings global agent and resolves a usable
   * `EmbeddingConfig` from it. Called from `reload()` automatically
   * (so a fresh config picks up the embeddings agent the user just
   * configured) and explicitly from places that mutate the agents
   * collection directly (the global-agent PUT route in commit 4 of
   * the global-agent split, which mutates `agent.embeddingBaseUrl`
   * alongside the embeddings row). Idempotent — safe to call
   * repeatedly. */
  async refreshEmbedding(): Promise<void> {
    const agent = await getGlobalAgent("embeddings");
    if (!agent) {
      this.embedding = null;
      return;
    }
    const providerDef = this.config.providers?.[agent.providerKey];
    if (!providerDef) {
      console.warn(`embeddings global agent references missing provider "${agent.providerKey}"; embedding disabled until a provider exists`);
      this.embedding = null;
      return;
    }
    // The full URL-resolution-rule chain lives in
    // `src/providers/embedding-url.ts` so the admin probe endpoint and
    // this runtime derive the same host for any given config. Three
    // inputs in priority order:
    //   1. `agent.embeddingBaseUrl` (set on the global agent) — explicit
    //      per-agent override; wins outright.
    //   2. `providerDef.embeddingUrl` (set on the named provider) —
    //      provider-level override; useful when pointing the embeddings
    //      agent at a provider whose chat baseUrl is on a non-default
    //      port or protocol.
    //   3. URL-shape heuristic — baseUrl with port 11430-11440 or
    //      hostname containing "ollama" implies Ollama's native
    //      /api/embeddings path on the bare origin (the chat path's
    //      /v1 prefix is stripped for the embeddings target). Anything
    //      else is OpenAI-compat and the consumer falls through to
    //      whatever the named provider exposes.
    // The consumer at `src/memory/embeddings.ts` is Ollama-shaped: it
    // always POSTs to `${baseUrl}/api/embeddings` with `{model, prompt}`.
    // OpenAI-compat embeddings need an explicit `providerDef.embeddingUrl`
    // pointed at the right base — the helper's `providerEmbeddingUrl`
    // path is the only way through for non-Ollama providers today.
    this.embedding = {
      baseUrl: resolveEmbeddingHost({
        agentOverride: agent.embeddingBaseUrl,
        providerEmbeddingUrl: providerDef.embeddingUrl,
        providerBaseUrl: providerDef.baseUrl,
      }),
      model: agent.model,
    };
  }
}
