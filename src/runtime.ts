import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRouter, type AvailabilityListener } from "./providers/router.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { ThrottledProvider, type ThrottleStats } from "./providers/throttle.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";

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
  embedding!: EmbeddingConfig;
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
    for (const [name, instance] of Object.entries(config.openaiCompatibleInstances)) {
      const inner = new OpenAICompatibleProvider(name, instance);
      if (instance.maxConcurrent) {
        const t = new ThrottledProvider(inner, { maxConcurrent: instance.maxConcurrent });
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
    this.embedding = config.embeddingProvider;
  }
}
