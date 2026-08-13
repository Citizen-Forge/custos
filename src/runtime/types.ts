// Stats/health snapshot shapes returned by Runtime.stats() and consumed by
// the admin endpoint, the periodic stats logger, and the threshold monitor.

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
  /** ms epoch of the next admissible request under the RPM spacing gate,
   *  or null when rpmLimit is unset. May be in the past. */
  rpmReadyAt: number | null;
}
