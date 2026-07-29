import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { GlobalQueue, type QueueContext } from "./providers/global-queue.js";
import { ProviderStateMap } from "./providers/provider-state.js";
import { ActivityLog, type DispatchContext } from "./providers/activity-log.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { AnthropicMessagesRequest } from "./types.js";
import type { Provider, CompleteOptions, ProviderResponse } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";
import { getGlobalAgent } from "./pm/global-agents.js";
import { resolveEmbeddingHost, looksLikeOllamaEndpoint } from "./providers/embedding-url.js";
import * as agentStore from "./pm/agents.js";
import { markProviderAvailable, markProviderUnavailable } from "./pm/model-registry.js";
import { syncSpawnedSessionCredentials } from "./auth/credentials.js";

/** Per-provider runtime stats, used by the admin endpoint, the periodic
 * stats logger, and the threshold-alert monitor. Reads from
 * ProviderStateMap.snapshot() directly -- the legacy overlay from
 * ProviderRouter.cooldowns() is gone because ProviderRouter itself is
 * gone (the queue's markCooling is the only source of cooling windows
 * now, and ProviderStateMap exposes them via snapshot()). Shape still
 * extends ThrottleStats for downstream consumers (`runtime-stats.ts`'s
 * alert rules, the admin panel's per-provider cards) so the surface
 * remains backward-compatible. */
export interface ProviderRuntimeStats {
  /** Per-provider throttle queue depth *background* — reads from
   *  ProviderStateMap.queuedBackground. */
  queuedBackground: number;
  /** Per-provider throttle queue depth *interactive* — reads from
   *  ProviderStateMap.queuedInteractive. */
  queuedInteractive: number;
  /** Currently in-flight requests. */
  active: number;
  /** Max concurrent in-flight requests. 0 = unlimited. */
  maxConcurrent: number;
  /** ms epoch when the provider's cooldown expires; undefined when
   *  currently available. Mirrors ProviderStateMap.snapshot()
   *  `coolingUntil` directly. */
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
 */export class Runtime {
  config!: GatewayConfig;
  /** Embedding target, now derived from the global embeddings agent
   *  (systemRole: "embeddings") rather than from a deprecated top-level
   *  `config.embeddingProvider` field. Null when no embeddings global
   *  agent is configured -- callers handle that by skipping embedding-
   *  dependent work rather than crashing. */
  embedding: EmbeddingConfig | null = null;
  readonly spendTracker = new SpendTracker();
  /** Global provider state map. Registered on reload, read by
   * GlobalQueue for availability checks. Source of truth for
   * availability — cooldown / breaker / capacity / RPM gates the
   * queue consults on every dispatch. Until the router drop (commit
   * no longer tracking), this was the queue's private working set
   * alongside the router's own CooldownTracker + CircuitBreaker. The
   * ProviderRouter equivalents are gone; ProviderStateMap now owns
   * the surface end-to-end. */
  readonly providerState = new ProviderStateMap();
  /** Ring-buffered activity log. The GlobalQueue writes
   *  queued/dispatched/fallback/succeeded/failed events into it; the
   *  admin endpoint reads from it. Survives config reloads -- a
   *  reload that swaps the GlobalQueue preserves the log so the
   *  operator can see activity that spans the reload boundary. */
  readonly activityLog = new ActivityLog();  /** Global queue replaces per-instance ThrottledProviders for
   *  centralized concurrency/RPM management. Created on reload,
   *  read directly by callers via the `globalQueue` accessor: the
   *  `/v1/messages` handler calls `queue.complete` with a chain it
   *  constructs inline from the request alias, and the curator /
   *  classifier paths go through `Runtime.completeViaProvider`
   *  which wraps the same call with a single-entry chain.
   *  No Runtime-level wrapper sits between callers and the queue —
   *  the queue is the dispatch surface. */
  private queue: GlobalQueue | null = null;
  /** Unsubscribe handles for the ProviderStateMap → model-registry
   *  availability listener chain. Re-bound on every reload so the
   *  previous bindings (in case anyone else has registered listeners)
   *  don't leak across reloads. */
  private availabilityUnsubs: Array<() => void> = [];
  /** `setInterval` handle for the periodic OAuth-mirror re-write. The
   *  third writer (likely the spawned `claude` CLI on auth rotation /
   *  rate-limit responses) can clobber `/root/.claude/.credentials.json`
   *  back to empty within seconds after our boot-time or per-spawn
   *  mirror runs. The re-mirror timer bounds that gap to the
   *  `intervalMs` threshold so a long-lived agent eventually reads a
   *  valid file even if a single transient clobber slipped between the
   *  boot-time sync and the first agent spawn. Default 30s interval is
   *  tunable via MIRROR_REFRESH_INTERVAL_MS env; the timer is owned by
   *  index.ts and torn down on Fastify `onClose`. */
  private mirrorRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mirrorRefreshIntervalMs: number = Number(process.env.MIRROR_REFRESH_INTERVAL_MS ?? 30_000);

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

  /** Start the periodic OAuth-mirror re-mirror timer. Idempotent — a second
   *  call cleanly replaces the existing timer (e.g. when a config edit
   *  triggers a runtime reload). The timer ticks `syncSpawnedSessionCredentials()`
   *  at the configured interval; that function returns gracefully on
   *  invalid/empty input (logs a warn, doesn't throw) so the timer
   *  never becomes a noise source beyond what's already emitted by the
   *  sync itself.
   *
   *  Disable contract: `MIRROR_REFRESH_INTERVAL_MS` of 0, any value
   *  below 1000ms, `undefined` after env-miss, or `NaN` (from a
   *  malformed env like `30s`) ALL disable the timer. Documented so a
   *  future maintainer doesn't try to "fix" the guard by inverting it
   *  (e.g. `if (val >= 1000)` would drop the `!val` short-circuit for
   *  NaN and accidentally schedule a 0-ms spin loop). The boot-time +
   *  per-spawn syncs still cover the common paths when disabled. */
  startMirrorRefresh(): void {
    if (this.mirrorRefreshTimer) clearInterval(this.mirrorRefreshTimer);
    if (!this.mirrorRefreshIntervalMs || this.mirrorRefreshIntervalMs < 1000) {
      // Treat sub-1000ms intervals as "off" rather than spinning the
      // event loop. The full disable contract (0 / NaN / undefined /
      // <1000) is documented in the JSDoc above -- this guard relies
      // on `!NaN === true` to short-circuit before the `< 1000` clause.
      console.warn(`[mirror-refresh] disabled: MIRROR_REFRESH_INTERVAL_MS=${this.mirrorRefreshIntervalMs}ms is below the 1000ms floor`);
      return;
    }
    this.mirrorRefreshTimer = setInterval(() => {
      void syncSpawnedSessionCredentials();
    }, this.mirrorRefreshIntervalMs);
    // Don't keep the process alive solely on this timer; Fastify keeps
    // the loop busy while it's listening, and on shutdown we explicitly
    // call stopMirrorRefresh() via Fastify's onClose hook.
    if (typeof this.mirrorRefreshTimer.unref === "function") {
      this.mirrorRefreshTimer.unref();
    }
  }

  /** Stop the periodic mirror-refresh timer. Safe to call when not
   *  running (no-op). Called from Fastify's onClose so SIGTERM/SIGINT/
   *  `app.close()` doesn't leave a dangling interval keeping the event
   *  loop busy. */
  stopMirrorRefresh(): void {
    if (!this.mirrorRefreshTimer) return;
    clearInterval(this.mirrorRefreshTimer);
    this.mirrorRefreshTimer = null;
  }

  /** Dispatch a single provider+model call through the GlobalQueue. Used
   *  by the memory curator and permission-classifier paths, both of which
   *  resolve their dispatch target via `primaryPick(agent, config)` and
   *  then send one request to that picked pair. Single-entry inline chain
   *  — no per-request failover; the curator / classifier paths retry on
   *  failure themselves if the response really didn't land. Returns the
   *  same `{ ...response, providerName }` shape that `Runtime.completeViaProvider`
   *  and the /v1/messages route handler discards (they all flow through
   *  GlobalQueue.complete which stamps providerName onto every response).
   *  Mirrors the legacy `router.completeWithEntries([{provider, priority:1}], ...)`
   *  shape one-for-one — the priority resolution that used to live in the
   *  router's per-entry loop is now explicitly passed via `options.priority`
   *  by each caller (`"background"` for the curator, `"interactive"`
   *  for the classifier). */
  async completeViaProvider(
    providerKey: string,
    model: string,
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
    context?: QueueContext,
  ): Promise<ProviderResponse & { providerName: string }> {
    if (!this.queue) throw new Error("GlobalQueue not initialized");
    return this.queue.complete(
      [{ provider: providerKey, model }],
      request,
      options,
      context,
    );
  }

  /** Per-provider stats snapshot aggregating ProviderStateMap.snapshot()
   *  for live state (active / queued-by-priority / cooldown / rpm). Used
   *  by the admin stats endpoint, the periodic stats logger, and the
   *  sustained-threshold alert monitor. Returns a fresh object on every
   *  call — no caching — so callers always see live data. The
   *  ProviderRouter overlay is gone: the queue's `markCooling` is the
   *  only source of cooling windows now, and ProviderStateMap surfaces
   *  them via snapshot(). Falls back to an empty stats object when
   *  called before the first `reload()` completes. */
  stats(): RuntimeStats {
    const providers: Record<string, ProviderRuntimeStats> = {};
    for (const [name, s] of Object.entries(this.providerState.snapshot())) {
      providers[name] = {
        active: s.active,
        queuedBackground: s.queuedBackground,
        queuedInteractive: s.queuedInteractive,
        maxConcurrent: s.maxConcurrent,
        cooldownUntil: s.coolingUntil ?? undefined,
      };
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
          // Sum interactive + background so the UI's per-entry queue depth
          // stays a single number it can render; the priority split is
          // available at the top-level provider stats layer (where the
          // alert rules read it), which is where the split is meaningful.
          queued = snap.queuedInteractive + snap.queuedBackground;
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
    // Publish the loaded config to `this.config` IMMEDIATELY after the
    // await returns, before any later step reads through it. Pre-migration,
    // `reload()` only stored `config` in the local variable; nothing
    // outside `reload()` read `this.config`, so the assignment was
    // latent and the runtime field's definite-assignment assertion
    // (`config!: GatewayConfig;`) covered the silence. After the
    // curator+classifier drop, `Runtime.refreshEmbedding()` and
    // `Runtime.completeViaProvider(...)` read `this.config` from
    // outside the reload scope; without this line those calls
    // receive `undefined` and `primaryPick(agent, undefined)` blows up
    // the boot with a TypeError that gives no hint that the root cause is
    // a missing assignment. The placement matters: BEFORE
    // `this.queue?.abortAll(...)` so any concurrent stats read during
    // the reload transition sees the new config rather than undefined.
    this.config = config;

    // Drop the old queue's in-flight work before re-registering providers
    // so a config edit doesn't leave old requests continuing to do work
    // against a runtime that's already switched shape underneath them.
    if (this.queue) this.queue.abortAll("runtime reload: config changed");

    // Up until the router drop, the runtime constructed two parallel
    // provider maps: a router-facing set with per-instance ThrottledProvider
    // wrappers, and a queue-facing set of bare providers. The wrappers were
    // duplicating per-instance state (concurrency / RPM) that the
    // ProviderStateMap-owned queue now handles globally. After the drop
    // there's only the bare set — single source of truth for "which
    // providers can accept work right now" — and every dispatch surface
    // (agents via `runtime.completeViaProvider`, the /v1/messages handler
    // via `runtime.globalQueue.complete` directly) reads from it.
    // No intermediate wrapper sits between callers and the queue; the
    // queue is the dispatch surface.
    const bareProviders: Record<string, Provider> = {};
    const stateMap = this.providerState;

    // Drop availability listeners from the previous load before
    // re-registering on the freshly-built state map (idempotent if the
    // state map reference is unchanged — `ProviderStateMap` is a new
    // instance only on first construction; on reload it survives config
    // changes but listeners need to be re-bound because the old state
    // map wound down with the old providers).
    for (const off of this.availabilityUnsubs) off();
    this.availabilityUnsubs = [];

    // Anthropic
    const anthropicInner = new AnthropicProvider({ apiKey: config.anthropic?.apiKey });
    bareProviders.anthropic = anthropicInner;
    // Anthropic parses its own reset headers from upstream
    // (`anthropic-ratelimit-unified-5h-reset` etc.) — the provider's
    // own cooldown handling is more precise than the global fallback
    // would be. No `cooldownFallbackMs` override on AnthropicConfig,
    // same as the legacy router's shape: Anthropic didn't get one.
    stateMap.register("anthropic", {
      maxConcurrent: config.anthropic?.maxConcurrent,
      rpmLimit: config.anthropic?.rpmLimit,
    });

    // New providers shape
    for (const [name, providerDef] of Object.entries(config.providers ?? {})) {
      const defaultModel = providerDef.models.find((m) => m.enabled) ?? providerDef.models[0];
      if (!defaultModel) continue;
      // Build per-model settings map so the provider can resolve
      // maxOutputTokens (and any future per-model tuning fields) at
      // dispatch time when modelOverride selects a non-default model.
      const modelSettings: Record<string, { maxOutputTokens?: number; maxContextWindow?: number }> = {};
      for (const m of providerDef.models) {
        const entry: { maxOutputTokens?: number; maxContextWindow?: number } = {};
        if (m.maxOutputTokens !== undefined) entry.maxOutputTokens = m.maxOutputTokens;
        if (m.maxContextWindow !== undefined) entry.maxContextWindow = m.maxContextWindow;
        if (Object.keys(entry).length > 0) modelSettings[m.name] = entry;
      }
      const instanceConfig = {
        baseUrl: providerDef.baseUrl,
        model: defaultModel.name,
        apiKey: providerDef.apiKey,
        pricing: defaultModel.pricing,
        maxConcurrent: providerDef.maxConcurrent,
        rpmLimit: providerDef.rpmLimit,
        priority: providerDef.priority,
        emitLateMetadataDelta: providerDef.emitLateMetadataDelta,
        maxRequestBytes: providerDef.maxRequestBytes,
        maxRequestBytesWarnRatio: providerDef.maxRequestBytesWarnRatio,
        models: Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
      };
      bareProviders[name] = new OpenAICompatibleProvider(name, instanceConfig);
      stateMap.register(name, {
        maxConcurrent: providerDef.maxConcurrent,
        rpmLimit: providerDef.rpmLimit,
        cooldownFallbackMs: providerDef.cooldownFallbackMs,
      });
    }

    // Legacy openaiCompatibleInstances (backward compat). The legacy
    // shape doesn't carry a `cooldownFallbackMs` field — operators on
    // this path can migrate to the new `providers.<name>` shape if
    // they need per-vendor cooldown defaults (e.g. setting Gemini
    // Free to 5min or Ollama to 30s). Until then, the global 60s
    // default kicks in.
    for (const [name, instance] of Object.entries(config.openaiCompatibleInstances)) {
      if (bareProviders[name]) continue;
      bareProviders[name] = new OpenAICompatibleProvider(name, instance);
      stateMap.register(name, {
        maxConcurrent: instance.maxConcurrent,
        rpmLimit: instance.rpmLimit,
      });
    }

    // Wire the model registry's `markProviderAvailable` /
    // `markProviderUnavailable` to the ProviderStateMap's lifecycle
    // listeners so the registry's per-model availability list mirrors
    // what ProviderStateMap knows. This replaces the old
    // `runtime.setAvailabilityListener(...)` chain in index.ts — the
    // listener body lived there before because ProviderRouter owned the
    // listeners; with the router gone, the wiring is the runtime's
    // responsibility, and the runtime is the only thing the boot path
    // touches. Subscribing once per reload keeps the registry's data
    // consistent across config edits without each caller having to
    // remember.
    this.availabilityUnsubs.push(
      stateMap.onUnavailable((provider, retryAfterMs, reason) => {
        void markProviderUnavailable(provider, retryAfterMs, reason);
      }),
      stateMap.onAvailable((provider) => {
        void markProviderAvailable(provider);
      }),
    );

    // Create or update the GlobalQueue. Share the runtime's activity
    // log with the queue so dispatch events land in the same buffer the
    // admin endpoint reads from. On reload the queue gets the same log
    // reference, so activity spanning the reload boundary survives
    // rather than vanishing into a fresh buffer the admin panel would
    // have to discover.
    if (this.queue) {
      this.queue.setProviders(bareProviders);
      this.queue.setStateMap(stateMap);
    } else {
      this.queue = new GlobalQueue(bareProviders, stateMap, this.activityLog);
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
    const baseUrl = resolveEmbeddingHost({
      agentOverride: agent.embeddingBaseUrl,
      providerEmbeddingUrl: providerDef.embeddingUrl,
      providerBaseUrl: providerDef.baseUrl,
    });

    // Determine the embeddings path and body format from the provider's
    // URL shape. Ollama's native endpoint lives at `/api/embeddings` (the
    // bare origin, no `/v1` prefix) and expects `{model, prompt}`.
    // OpenAI-compat providers expose `/embeddings` (under their existing
    // path prefix, e.g. `/v1/embeddings`) and expect `{model, input}`.
    // The heuristic checks the agent override first (most specific), then
    // the provider embedding URL override, then the provider base URL.
    const isOllama = looksLikeOllamaEndpoint(
      agent.embeddingBaseUrl ?? providerDef.embeddingUrl ?? providerDef.baseUrl,
    );

    this.embedding = {
      baseUrl,
      path: isOllama ? "/api/embeddings" : "/embeddings",
      model: pick.model,
    };
  }
}
