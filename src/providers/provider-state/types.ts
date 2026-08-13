export interface ProviderStateEntry {
  /** When the provider may try again after a 429/5xx. ms epoch. */
  coolingUntil: number | null;
  /** When the circuit breaker expires. ms epoch. null when not broken. */
  breakerUntil: number | null;
  /** Max concurrent in-flight requests. 0 = unlimited. */
  maxConcurrent: number;
  /** Currently in-flight requests. */
  active: number;
  /** Queued interactive requests waiting for a slot on this provider. */
  queuedInteractive: number;
  /** Queued background requests waiting for a slot on this provider. */
  queuedBackground: number;
  /** Requests-per-minute limit. null = unlimited. */
  rpmLimit: number | null;
  /** Earliest time (ms epoch) the next request may be admitted, when
   *  rpmLimit is set. Requests are spaced evenly at 60_000/rpmLimit ms
   *  apart -- deliberately not a bursty token bucket. A token bucket
   *  starts full and lets up to rpmLimit requests through back-to-back
   *  the moment they're all ready (e.g. right after a cooldown clears),
   *  which is exactly what tripped repeated real 429s from Anthropic in
   *  production: 6 near-simultaneous requests succeeded, then the next
   *  two fired together and were both rejected, even with rpmLimit set
   *  well above the 60s-average rate that burst worked out to. Anthropic
   *  cared about spacing within the burst, not just the per-minute
   *  total, and a token bucket has no notion of spacing at all. */
  nextRpmSlotAt: number;
  /** Per-provider cooldown fallback ms (e.g. Gemini = 5min, Ollama = 30s). */
  cooldownFallbackMs: number | null;
}

export interface ProviderStateInit {
  maxConcurrent?: number;
  rpmLimit?: number;
  cooldownFallbackMs?: number;
}

/** Listener fired when a provider enters a cooldown / breaker state.
 *  Carries the duration so the listener can record an analogous unavailable
 *  window in the model registry without needing to re-derive it. */
export type ProviderUnavailableListener = (provider: string, retryAfterMs: number, reason: string) => void;

/** Listener fired after a successful request clears all breaker / cooldown
 *  state for a provider. The model registry uses this to drop a cooldown
 *  early, since a successful completion is proof the window reopened
 *  sooner than advertised. */
export type ProviderAvailableListener = (provider: string) => void;
