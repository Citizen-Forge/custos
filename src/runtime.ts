import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRouter, type AvailabilityListener } from "./providers/router.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { ThrottledProvider, type ThrottleStats } from "./providers/throttle.js";
import { GlobalQueue } from "./providers/global-queue.js";
import { ProviderStateMap } from "./providers/provider-state.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { AnthropicMessagesRequest } from "./types.js";
import type { Provider, CompleteOptions, ProviderResponse } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";
import { getGlobalAgent } from "./pm/global-agents.js";
import { resolveEmbeddingHost } from "./providers/embedding-url.js";
import * as agentStore from "./pm/agents.js";

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
  /** Per-fallback-set health. Operators see at a glance whether each
   *  named chain has a live pick or whether every entry is currently
   *  unavailable, without having to triangulate cooldown / breaker /
   *  RPM signals across the per-provider map. The set-name keys match
   *  `config.fallbackSets` -- if a set has been removed from config
   *  since the snapshot was taken, it simply disappears from the next
   *  refresh. */
  fallbackSets: Record<string, FallbackSetHealth>;
  /** ms epoch at which the snapshot was taken -- useful when log lines
   *  and HTTP responses are correlated after the fact. */
  timestamp: number;
}

/** Per-fallback-set health snapshot. Keyed by set name in
 *  RuntimeStats.fallbackSets. The chain entries are reported in
 *  declared order (matching `config.fallbackSets[name].providers`)
 *  so the UI can render the priority sequence top-to-bottom without
 *  re-sorting. */
export interface FallbackSetHealth {
  /** Set name as it appears in `config.fallbackSets`. */
  name: string;
  /** Set description, lifted from the config for the panel header. */
  description: string;
  /** Chain length. 0 for an empty set (rare; surfaced as exhausted). */
  chainLength: number;
  /** Per-entry health, in declared order. */
  entries: FallbackSetEntryHealth[];
  /** First entry whose `status === "available"`, or null when the
   *  whole set is exhausted. The "live pick" -- what an incoming
   *  request would actually dispatch to. */
  livePick: { provider: string; model: string; index: number } | null;
  /** True when no entry in the chain can accept a request right now.
   *  Equivalent to `livePick === null && chainLength > 0`, but cached
   *  so the UI doesn't have to recompute. */
  exhausted: boolean;
}

/** Per-entry health inside a fallback set's chain. */
export interface FallbackSetEntryHealth {
  provider: string;
  model: string;
  /** Coarse availability for this entry. The statuses are mutually
   *  exclusive; the order they appear in `providerState.canAccept()`
   *  determines which one wins when multiple gates fail (cooldown
   *  before breaker, breaker before capacity, capacity before RPM).
   *  The "unregistered" status means the provider name has no entry
   *  in `ProviderStateMap` at all -- a config drift where the set
   *  references a provider the runtime never registered (e.g. a typo
   *  in `providers.<name>` or a missing default). */
  status: "available" | "cooldown" | "circuit-broken" | "at-capacity" | "rpm-exhausted" | "unregistered";
  coolingUntil: number | null;
  breakerUntil: number | null;
  active: number;
  /** Sub-queue depth for this provider (interactive + background). */
  queued: number;
  maxConcurrent: number;
  rpmLimit: number | null;
  rpmTokens: number | null;
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
  /** Global provider state map. Registered on reload, read by
   *  GlobalQueue for availability checks. */
  readonly providerState = new ProviderStateMap();
  /** Global queue replaces per-instance ThrottledProviders for
   *  centralized concurrency/RPM management and fallback-set-aware
   *  dispatching. Created on reload, used by completeWithFallback. */
  private queue: GlobalQueue | null = null;
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

  /** Best-guess default model for a fallback set (first entry's model).
   *  Used by the /v1/messages handler to set `body.model` before the
   *  request enters the GlobalQueue. The GlobalQueue may override this
   *  via `modelOverride` if it dispatches to a different entry, but the
   *  body field needs at least a sensible value for the ingestion
   *  pipeline (which reads `body.model` pre-routing) and for providers
   *  that don't support `modelOverride` (none configured today, but
   *  defensively). */
  fallbackDefaultModel(setName: string): string {
    return this.config.fallbackSets?.[setName]?.providers[0]?.model ?? "unknown";
  }

  /** Complete a request using a fallback set from the agent's config.
   *  Resolves through the GlobalQueue, iterating the fallback set's
   *  providers in order and using the first available one. The model
   *  from each fallback entry is passed as modelOverride so the
   *  provider uses the fallback set's chosen model rather than its
   *  default. Falls back to the router's task-based routing when the
   *  agent has no fallback set configured (backward compat). */
  async completeWithFallback(
    fallbackSetName: string,
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
  ): Promise<ProviderResponse & { providerName: string }> {
    const set = this.config.fallbackSets?.[fallbackSetName];
    if (!set || !set.providers.length) {
      throw new Error(`Fallback set "${fallbackSetName}" is not configured or is empty`);
    }
    if (this.queue) {
      return this.queue.complete(
        set.providers.map((p) => ({ provider: p.provider, model: p.model })),
        request,
        options,
      );
    }
    throw new Error("GlobalQueue not initialized");
  }

  /** Resolve a fallback set to the first available provider+model and
   *  acquire a slot. Checks ProviderStateMap for each provider in the
   *  set and returns the first one that can accept a request (with its
   *  slot already acquired). Returns null when no provider is available.
   *  The CALLER is responsible for releasing the acquired slot via the
   *  returned release function, typically in a finally block.
   *  The agent-runner calls this before spawning claude so the initial
   *  model selection reserves capacity on the chosen provider instead
   *  of just checking availability race-ily.
   *
   *  Reads only the agent's `fallbackSet`. The historical
   *  `providerKey`/`model` fields were dropped from `AgentDef` in the
   *  providerKey/model schema drop (commit message pending) -- the
   *  primary pick is now derived at read time via
   *  `agents.primaryPick(agent, config)`. The Pick shape here keeps the
   *  method signature narrow so callers that only carry an `AgentDef`
   *  subset still work. */
  resolveFallbackSet(agent: { fallbackSet?: string }): { providerKey: string; model: string; release: () => void } | null {
    if (!agent.fallbackSet) return null;
    const set = this.config.fallbackSets?.[agent.fallbackSet];
    if (!set || !set.providers.length) return null;
    for (const entry of set.providers) {
      if (this.providerState.canAccept(entry.provider)) {
        const release = this.providerState.acquire(entry.provider);
        return { providerKey: entry.provider, model: entry.model, release };
      }
    }
    return null;
  }

  /** Access the GlobalQueue for direct calls (e.g. from agent-runner). */
  get globalQueue(): GlobalQueue | null {
    return this.queue;
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
      return { providers: {}, fallbackSets: {}, timestamp: Date.now() };
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
    return {
      providers,
      fallbackSets: this.fallbackSetHealth(),
      timestamp: Date.now(),
    };
  }

  /** Per-fallback-set health: for each set in config, walk the chain
   *  in declared order, classify each entry against ProviderStateMap,
   *  and pick the first available entry as the "live pick". A set
   *  with zero live picks is `exhausted: true` -- the runtime would
   *  queue any incoming request rather than dispatch it. The shape
   *  is intended for the admin panel; consumers that need per-provider
   *  numbers should read `providerState.snapshot()` directly.
   *
   *  Pure: reads `this.config.fallbackSets` and `this.providerState`,
   *  no I/O. Returns a fresh object on every call. */
  fallbackSetHealth(): Record<string, FallbackSetHealth> {
    const out: Record<string, FallbackSetHealth> = {};
    const sets = this.config.fallbackSets ?? {};
    const stateMap = this.providerState;
    const now = Date.now();
    for (const [name, set] of Object.entries(sets)) {
      const entries: FallbackSetEntryHealth[] = [];
      let livePick: FallbackSetHealth["livePick"] = null;
      for (let i = 0; i < set.providers.length; i++) {
        const entry = set.providers[i];
        const state = stateMap.get(entry.provider);
        let status: FallbackSetEntryHealth["status"];
        let coolingUntil: number | null = null;
        let breakerUntil: number | null = null;
        let active = 0;
        let queued = 0;
        let maxConcurrent = 0;
        let rpmLimit: number | null = null;
        let rpmTokens: number | null = null;
        if (!state) {
          status = "unregistered";
        } else {
          // Snapshot to a local copy BEFORE reading or refilling so a
          // concurrent canAccept() call from GlobalQueue doesn't race
          // with us writing back to the shared state. The shared
          // providerState entries are mutable (acquire/release mutate
          // active, canAccept mutates rpmTokens/lastRpmRefill) so two
          // readers writing back can produce a torn read where, e.g.,
          // one reader's rpmTokens overwrite loses the other's last
          // refill delta. snapshot-into-local is the cheapest fix that
          // keeps ProviderStateMap's existing public API unchanged.
          const snap = { ...state };
          coolingUntil = snap.coolingUntil;
          breakerUntil = snap.breakerUntil;
          active = snap.active;
          queued = snap.queued;
          maxConcurrent = snap.maxConcurrent;
          rpmLimit = snap.rpmLimit;
          // Refill tokens the same way canAccept does so the reported
          // rpmTokens matches the gate decision the runtime actually
          // uses (a bucket can refill between snapshot reads, and
          // reporting a stale low value would falsely advertise
          // rpm-exhausted when the next request would be admitted).
          // This computation runs on the local snap only -- the shared
          // state entry is untouched.
          if (snap.rpmLimit !== null) {
            const elapsedMs = now - snap.lastRpmRefill;
            if (elapsedMs > 0) {
              const add = (elapsedMs / 60_000) * snap.rpmLimit;
              snap.rpmTokens = Math.min(snap.rpmLimit, snap.rpmTokens + add);
              snap.lastRpmRefill = now;
            }
            rpmTokens = Math.max(0, Math.round(snap.rpmTokens * 100) / 100);
          }
          // Classify in the same gate order canAccept uses. Cooldown
          // wins first because a 429/503 is the most transient and the
          // caller has the Retry-After to plan around; breaker second
          // because it's a recovery-state signal; capacity third
          // because that's the steady-state signal; RPM last because
          // it's the most predictive (a momentary burst shouldn't read
          // as "exhausted" to the operator when a refill is due in
          // seconds).
          if (coolingUntil !== null && now < coolingUntil) status = "cooldown";
          else if (breakerUntil !== null && now < breakerUntil) status = "circuit-broken";
          else if (maxConcurrent > 0 && active >= maxConcurrent) status = "at-capacity";
          else if (rpmLimit !== null && rpmTokens !== null && rpmTokens < 1) status = "rpm-exhausted";
          else status = "available";
        }
        entries.push({
          provider: entry.provider,
          model: entry.model,
          status,
          coolingUntil,
          breakerUntil,
          active,
          queued,
          maxConcurrent,
          rpmLimit,
          rpmTokens,
        });
        if (livePick === null && status === "available") {
          livePick = { provider: entry.provider, model: entry.model, index: i };
        }
      }
      out[name] = {
        name,
        description: set.description,
        chainLength: set.providers.length,
        entries,
        livePick,
        exhausted: livePick === null && set.providers.length > 0,
      };
    }
    return out;
  }

  async reload(): Promise<void> {
    const config = await loadConfig();

    // Drop the old throttles before building new providers so any
    // in-flight inner fetches stop promptly.
    for (const old of this.liveThrottles) {
      old.abortAll("runtime reload: config changed");
    }

    // Build the router providers (uses ThrottledProvider wrappers for
    // backward compat with existing task-based routing).
    const routerProviders: Record<string, Provider> = {};
    const newThrottles = new Set<ThrottledProvider>();
    const routerAnthropicInner = new AnthropicProvider({ apiKey: config.anthropic?.apiKey });
    if (config.anthropic?.maxConcurrent) {
      const t = new ThrottledProvider(routerAnthropicInner, { maxConcurrent: config.anthropic.maxConcurrent });
      routerProviders.anthropic = t;
      newThrottles.add(t);
    } else {
      routerProviders.anthropic = routerAnthropicInner;
    }
    for (const [name, providerDef] of Object.entries(config.providers ?? {})) {
      const defaultModel = providerDef.models.find((m) => m.enabled) ?? providerDef.models[0];
      if (!defaultModel) continue;
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
        routerProviders[name] = new ThrottledProvider(inner, opts);
        newThrottles.add(routerProviders[name] as ThrottledProvider);
      } else {
        routerProviders[name] = inner;
      }
    }
    // Legacy instances.
    for (const [name, instance] of Object.entries(config.openaiCompatibleInstances)) {
      if (routerProviders[name]) continue;
      const inner = new OpenAICompatibleProvider(name, instance);
      if (instance.maxConcurrent || instance.rpmLimit) {
        const opts: { maxConcurrent: number; rpmLimit?: number } = {
          maxConcurrent: instance.maxConcurrent ?? 1,
        };
        if (instance.rpmLimit) opts.rpmLimit = instance.rpmLimit;
        routerProviders[name] = new ThrottledProvider(inner, opts);
        newThrottles.add(routerProviders[name] as ThrottledProvider);
      } else {
        routerProviders[name] = inner;
      }
    }

    this.config = config;
    this.router = new ProviderRouter(routerProviders, config, this.spendTracker);
    this.liveThrottles.clear();
    for (const t of newThrottles) this.liveThrottles.add(t);
    if (this.availabilityListener) this.router.setAvailabilityListener(this.availabilityListener);

    // Build bare providers for the GlobalQueue (no ThrottledProvider
    // wrappers — GlobalQueue handles concurrency/RPM centrally via
    // ProviderStateMap).
    const bareProviders: Record<string, Provider> = {};
    const stateMap = this.providerState;

    // Anthropic
    const anthropicInner = new AnthropicProvider({ apiKey: config.anthropic?.apiKey });
    bareProviders.anthropic = anthropicInner;
    stateMap.register("anthropic", {
      maxConcurrent: config.anthropic?.maxConcurrent,
      rpmLimit: config.anthropic?.rpmLimit,
    });

    // New providers shape
    for (const [name, providerDef] of Object.entries(config.providers ?? {})) {
      const defaultModel = providerDef.models.find((m) => m.enabled) ?? providerDef.models[0];
      if (!defaultModel) continue;
      const instanceConfig = {
        baseUrl: providerDef.baseUrl,
        model: defaultModel.name,
        apiKey: providerDef.apiKey,
        pricing: defaultModel.pricing,
        maxConcurrent: undefined,
        rpmLimit: undefined,
        priority: providerDef.priority,
        emitLateMetadataDelta: providerDef.emitLateMetadataDelta,
      };
      bareProviders[name] = new OpenAICompatibleProvider(name, instanceConfig);
      stateMap.register(name, {
        maxConcurrent: providerDef.maxConcurrent,
        rpmLimit: providerDef.rpmLimit,
        cooldownFallbackMs: providerDef.cooldownFallbackMs,
      });
    }

    // Legacy openaiCompatibleInstances (backward compat)
    for (const [name, instance] of Object.entries(config.openaiCompatibleInstances)) {
      if (bareProviders[name]) continue;
      bareProviders[name] = new OpenAICompatibleProvider(name, instance);
      stateMap.register(name, {
        maxConcurrent: instance.maxConcurrent,
        rpmLimit: instance.rpmLimit,
      });
    }

    // Create or update the GlobalQueue.
    if (this.queue) {
      this.queue.abortAll("runtime reload: config changed");
      this.queue.setProviders(bareProviders);
      this.queue.setStateMap(stateMap);
    } else {
      this.queue = new GlobalQueue(bareProviders, stateMap);
    }

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
    // Resolve the embeddings provider through the global agent's
    // fallbackSet rather than reading a stale `agent.providerKey`. The
    // agent-row field was dropped along with `AgentDef.providerKey` /
    // `model` in the schema-cleanup commit; primaryPick is the single
    // source of truth for "which provider does this agent currently
    // dispatch to" across the runtime.
    const pick = agentStore.primaryPick(agent, this.config);
    if (!pick) {
      console.warn(`embeddings global agent has no live primary pick (fallbackSet="${agent.fallbackSet ?? "<unset>"}"); embedding disabled until a fallback set is assigned`);
      this.embedding = null;
      return;
    }
    const providerDef = this.config.providers?.[pick.providerKey];
    if (!providerDef) {
      console.warn(`embeddings global agent references missing provider "${pick.providerKey}"; embedding disabled until a provider exists`);
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
      model: pick.model,
    };
  }
}
