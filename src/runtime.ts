import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRouter, type AvailabilityListener } from "./providers/router.js";
import { SpendTracker } from "./providers/spend-tracker.js";
import { ThrottledProvider } from "./providers/throttle.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";

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
