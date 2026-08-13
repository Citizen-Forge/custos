// Pure stats/health computation over a ProviderStateMap snapshot + the
// current config. No I/O, no instance state -- both functions are called
// fresh on every Runtime.stats() / Runtime.fallbackSetHealth() so callers
// never see stale data through a shared reference.
import type { GatewayConfig } from "../config.js";
import type { ProviderStateMap } from "../providers/provider-state.js";
import type { FallbackSetEntryHealth, FallbackSetHealth, ProviderRuntimeStats } from "./types.js";

export function computeProviderStats(providerState: ProviderStateMap): Record<string, ProviderRuntimeStats> {
  const providers: Record<string, ProviderRuntimeStats> = {};
  for (const [name, s] of Object.entries(providerState.snapshot())) {
    providers[name] = {
      active: s.active,
      queuedBackground: s.queuedBackground,
      queuedInteractive: s.queuedInteractive,
      maxConcurrent: s.maxConcurrent,
      cooldownUntil: s.coolingUntil ?? undefined,
    };
  }
  return providers;
}

/** Per-fallback-set health: for each set in config, walk the chain
 *  in declared order, classify each entry against ProviderStateMap,
 *  and pick the first available entry as the "live pick". A set
 *  with zero live picks is `exhausted: true` -- the runtime would
 *  queue any incoming request rather than dispatch it. The shape
 *  is intended for the admin panel; consumers that need per-provider
 *  numbers should read `providerState.snapshot()` directly. */
export function computeFallbackSetHealth(config: GatewayConfig, providerState: ProviderStateMap): Record<string, FallbackSetHealth> {
  const out: Record<string, FallbackSetHealth> = {};
  const sets = config.fallbackSets ?? {};
  const now = Date.now();
  for (const [name, set] of Object.entries(sets)) {
    const entries: FallbackSetEntryHealth[] = [];
    let livePick: FallbackSetHealth["livePick"] = null;
    for (let i = 0; i < set.providers.length; i++) {
      const entry = set.providers[i];
      const state = providerState.get(entry.provider);
      let status: FallbackSetEntryHealth["status"];
      let coolingUntil: number | null = null;
      let breakerUntil: number | null = null;
      let active = 0;
      let queued = 0;
      let maxConcurrent = 0;
      let rpmLimit: number | null = null;
      let rpmReadyAt: number | null = null;
      if (!state) {
        status = "unregistered";
      } else {
        // Snapshot to a local copy before reading so a concurrent
        // acquire()/canAccept() call from GlobalQueue can't be observed
        // mid-mutation -- state.active/nextRpmSlotAt are mutable, this
        // is a point-in-time read only.
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
        rpmReadyAt = snap.rpmLimit !== null ? snap.nextRpmSlotAt : null;
        // Classify in the same gate order canAccept uses. Cooldown
        // wins first because a 429/503 is the most transient and the
        // caller has the Retry-After to plan around; breaker second
        // because it's a recovery-state signal; capacity third
        // because that's the steady-state signal; RPM last because
        // it's the most predictive (a slot due in a second or two
        // shouldn't read as "exhausted" to the operator the same way
        // a genuinely stuck provider does).
        if (coolingUntil !== null && now < coolingUntil) status = "cooldown";
        else if (breakerUntil !== null && now < breakerUntil) status = "circuit-broken";
        else if (maxConcurrent > 0 && active >= maxConcurrent) status = "at-capacity";
        else if (rpmReadyAt !== null && now < rpmReadyAt) status = "rpm-exhausted";
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
        rpmReadyAt,
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
