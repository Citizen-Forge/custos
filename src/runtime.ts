import { GlobalQueue, PERIODIC_PUMP_INTERVAL_MS, type QueueContext } from "./providers/global-queue.js";
import { ProviderStateMap } from "./providers/provider-state.js";
import { ActivityLog } from "./providers/activity-log.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { AnthropicMessagesRequest } from "./types.js";
import { ProviderUnavailableError } from "./types.js";
import type { Provider, CompleteOptions, ProviderResponse } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";
import { getGlobalAgent } from "./pm/global-agents.js";
import { markProviderAvailable, markProviderUnavailable } from "./pm/model-registry.js";
import { syncSpawnedSessionCredentials } from "./auth/credentials.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { buildBareProviders } from "./runtime/provider-registry.js";
import { computeFallbackSetHealth, computeProviderStats } from "./runtime/stats.js";
import { resolveEmbeddingTarget } from "./runtime/embeddings.js";

export type { ProviderRuntimeStats, RuntimeStats, FallbackSetHealth, FallbackSetEntryHealth } from "./runtime/types.js";
import type { FallbackSetHealth, RuntimeStats } from "./runtime/types.js";

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
  readonly activityLog = new ActivityLog();
  /** Global queue replaces per-instance ThrottledProviders for
   *  centralized concurrency/RPM management. Created on reload,
   *  read directly by callers via the `globalQueue` accessor: the
   *  `/v1/messages` handler calls `queue.complete` with a chain it
   *  constructs inline from the request alias, and the curator /
   *  classifier paths go through `Runtime.completeViaProvider`
   *  which wraps the same call with a single-entry chain.
   *  No Runtime-level wrapper sits between callers and the queue —
   *  the queue is the dispatch surface. */
  private queue: GlobalQueue | null = null;
  /** Bare provider instances keyed by name. Held here separately from
   *  the GlobalQueue so the pre-spawn probe (see `probeProvider` below
   *  and `pm/probe.ts`) can call a provider's `complete()` directly
   *  without going through the queue. Going through the queue would
   *  double-count the agent-runner's already-acquired concurrency
   *  slot on `maxConcurrent: 1` providers like the local Ollama and
   *  would add a needless mark-cooling event to the activity log
   *  every time the probe rejected an upstream. */
  private bareProviders: Record<string, Provider> = {};
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

  /**
   * Fires a 1-token probe straight at the named provider+model, bypassing
   * the GlobalQueue entirely. Caller is responsible for inspecting the
   * returned `ProviderResponse` and throwing if the upstream rejects
   * (see `pm/probe.ts` for the policy). Kept here on the Runtime rather
   * than exposed via a queue accessor because the probe is intentionally
   * a different dispatch surface -- it goes around availability
   * accounting, around the activity log, around cooldown writes -- so
   * callers see only one "pre-spawn probe rejected" line on failure
   * rather than a queue/noise/markCooling cascade.
   *
   * OpenAI-compatible providers throw `ProviderUnavailableError` on 429/5xx
   * before the probe can read the response body. We catch that and reduce
   * it to a synthetic `ProviderResponse` whose status matches what the
   * provider WOULD have returned, so the probe's status-based policy
   * (`429 → abort as rate-limited`, `5xx → proceed`) still fires for the
   * common case without any per-call special casing in `probe.ts`.
   *
   * The `model` argument is forwarded as `modelOverride` so the probe
   * always pins to the agent's fallback-set entry rather than the
   * provider's constructed default. Without this the probe would send
   * to whatever the provider was configured with first (e.g. the
   * healthy `llama-3.1-8b-instant`) even when the failing entry is
   * the SECOND model in the set (`llama-3.3-70b-versatile`, which has
   * the 12k TPM cap on free Groq). The probe's signal would then be
   * a false negative on every cycle.
   */
  async probeProvider(providerKey: string, model: string, request: AnthropicMessagesRequest): Promise<ProviderResponse> {
    const provider = this.bareProviders[providerKey];
    if (!provider) {
      throw new Error(`runtime.probeProvider: no registered provider for "${providerKey}"`);
    }
    try {
      return await provider.complete(request, { priority: "background", modelOverride: model });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        const match = /HTTP (\d{3})/.exec(err.message);
        const status = match ? Number(match[1]) : 503;
        const headers = new Headers();
        return { status, headers, body: new Blob([]).stream() };
      }
      throw err;
    }
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
   *  call — no caching — so callers always see live data. Falls back to
   *  an empty stats object when called before the first `reload()`
   *  completes. */
  stats(): RuntimeStats {
    return {
      providers: computeProviderStats(this.providerState),
      fallbackSets: this.fallbackSetHealth(),
      timestamp: Date.now(),
    };
  }

  /** See runtime/stats.ts's `computeFallbackSetHealth` -- pure, reads
   *  `this.config.fallbackSets` and `this.providerState`, no I/O. */
  fallbackSetHealth(): Record<string, FallbackSetHealth> {
    return computeFallbackSetHealth(this.config, this.providerState);
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
    const stateMap = this.providerState;

    // Drop availability listeners from the previous load before
    // re-registering on the freshly-built state map (idempotent if the
    // state map reference is unchanged — `ProviderStateMap` is a new
    // instance only on first construction; on reload it survives config
    // changes but listeners need to be re-bound because the old state
    // map wound down with the old providers).
    for (const off of this.availabilityUnsubs) off();
    this.availabilityUnsubs = [];

    const bareProviders = buildBareProviders(config, stateMap);

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
      // periodicPumpIntervalMs: opt-in on GlobalQueue (see its own doc
      // comment) -- this is the one real production instance, so it's the
      // one place that should actually enable the safety-net sweep.
      this.queue = new GlobalQueue(bareProviders, stateMap, this.activityLog, {
        periodicPumpIntervalMs: PERIODIC_PUMP_INTERVAL_MS,
      });
    }
    // Mirror the bare provider map onto the Runtime so pre-spawn probes
    // can bypass the GlobalQueue without each probe call reconstructing
    // the provider graph from config (see `probeProvider` above).
    this.bareProviders = bareProviders;

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
    this.embedding = agent ? resolveEmbeddingTarget(agent, this.config) : null;
  }
}
