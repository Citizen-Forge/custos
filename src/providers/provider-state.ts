/**
 * Global provider state — the single source of truth for whether each
 * provider can accept a request right now.
 *
 * Moved out of per-instance ThrottledProvider wrappers and into a central
 * map so the GlobalQueue can check availability across multiple providers
 * in a fallback set in one place, without needing to hold references to
 * every ThrottledProvider instance.
 *
 * Every field is per-provider, keyed by provider name (e.g. "anthropic",
 * "ollama", "gemini-free").
 */

export interface ProviderStateEntry {
  /** When the provider may try again after a 429/5xx. ms epoch. */
  coolingUntil: number | null;
  /** When the circuit breaker expires. ms epoch. null when not broken. */
  breakerUntil: number | null;
  /** Max concurrent in-flight requests. 0 = unlimited. */
  maxConcurrent: number;
  /** Currently in-flight requests. */
  active: number;
  /** Queued requests waiting for a slot on this provider. */
  queued: number;
  /** Requests-per-minute limit. null = unlimited. */
  rpmLimit: number | null;
  /** Current RPM token-bucket level. Starts at rpmLimit. */
  rpmTokens: number;
  /** Last RPM token refill timestamp. */
  lastRpmRefill: number;
  /** Per-provider cooldown fallback ms (e.g. Gemini = 5min, Ollama = 30s). */
  cooldownFallbackMs: number | null;
}

export interface ProviderStateInit {
  maxConcurrent?: number;
  rpmLimit?: number;
  cooldownFallbackMs?: number;
}

export class ProviderStateMap {
  private readonly state = new Map<string, ProviderStateEntry>();

  /** Register a provider so the queue can check it. Idempotent — an
   * existing entry is updated with new init values but never fully replaced
   * (preserving in-flight counters across config reloads). */
  register(name: string, init?: ProviderStateInit): void {
    const existing = this.state.get(name);
    if (existing) {
      // Update settings but preserve live counters.
      if (init?.maxConcurrent !== undefined) existing.maxConcurrent = init.maxConcurrent;
      if (init?.rpmLimit !== undefined) {
        existing.rpmLimit = init.rpmLimit;
        existing.rpmTokens = Math.min(existing.rpmTokens, init.rpmLimit);
      }
      if (init?.cooldownFallbackMs !== undefined) existing.cooldownFallbackMs = init.cooldownFallbackMs;
      return;
    }
    this.state.set(name, {
      coolingUntil: null,
      breakerUntil: null,
      maxConcurrent: init?.maxConcurrent ?? 0,
      active: 0,
      queued: 0,
      rpmLimit: init?.rpmLimit ?? null,
      rpmTokens: init?.rpmLimit ?? 0,
      lastRpmRefill: Date.now(),
      cooldownFallbackMs: init?.cooldownFallbackMs ?? null,
    });
  }

  /** Remove a provider from the map entirely. Called when a provider is
   * deleted from config. */
  unregister(name: string): void {
    this.state.delete(name);
  }

  /** The current entry for a provider, or undefined if not registered. */
  get(name: string): ProviderStateEntry | undefined {
    return this.state.get(name);
  }

  /** Refill RPM tokens based on elapsed time. */
  private refillTokens(entry: ProviderStateEntry): void {
    if (entry.rpmLimit === null) return;
    const now = Date.now();
    const elapsedMs = now - entry.lastRpmRefill;
    if (elapsedMs <= 0) return;
    const add = (elapsedMs / 60_000) * entry.rpmLimit;
    entry.rpmTokens = Math.min(entry.rpmLimit, entry.rpmTokens + add);
    entry.lastRpmRefill = now;
  }

  /** Check if a provider can accept a request right now. Returns true if
   * all gates pass (not cooling, not circuit-broken, under concurrency cap,
   * has RPM tokens). This is a read-only check — does NOT consume anything. */
  canAccept(name: string): boolean {
    const entry = this.state.get(name);
    if (!entry) return false;
    const now = Date.now();
    // Cooldown gate
    if (entry.coolingUntil !== null && now < entry.coolingUntil) return false;
    // Circuit breaker gate
    if (entry.breakerUntil !== null && now < entry.breakerUntil) return false;
    // Concurrency gate (0 = unlimited)
    if (entry.maxConcurrent > 0 && entry.active >= entry.maxConcurrent) return false;
    // RPM gate
    this.refillTokens(entry);
    if (entry.rpmLimit !== null && entry.rpmTokens < 1) return false;
    return true;
  }

  /** Atomically acquire a slot for a provider. Must be preceded by a
   * canAccept() check, or the promise will reject. Returns a release
   * function that the caller MUST call in a finally block. */
  acquire(name: string): () => void {
    const entry = this.state.get(name);
    if (!entry) throw new Error(`Provider "${name}" is not registered`);
    this.refillTokens(entry);
    entry.active++;
    if (entry.rpmLimit !== null) entry.rpmTokens = Math.max(0, entry.rpmTokens - 1);
    return () => this.release(name);
  }

  private release(name: string): void {
    const entry = this.state.get(name);
    if (!entry) return;
    entry.active = Math.max(0, entry.active - 1);
    // Signal any waiting observers that a slot freed up.
    // Pump is called externally via pumpAll().
  }

  /** Mark a provider as cooling down. Duration follows the precedence
   * chain: retryAfterMs (upstream Retry-After) → cooldownFallbackMs
   * (per-provider config) → null (caller's default). */
  markCooling(name: string, retryAfterMs?: number | null, fallbackMs?: number | null): void {
    const entry = this.state.get(name);
    if (!entry) return;
    const effectiveMs = retryAfterMs ?? fallbackMs ?? null;
    if (effectiveMs === null) return;
    entry.coolingUntil = Date.now() + Math.max(1000, effectiveMs);
  }

  /** Record a successful request — clears any active circuit breaker
   * state for this provider. */
  recordSuccess(name: string): void {
    const entry = this.state.get(name);
    if (!entry) return;
    entry.breakerUntil = null;
  }

  /** Circuit breaker configuration: 5 failures within a 60s sliding
   *  window trips the breaker. First trip: 60s cooldown. Subsequent
   *  trips: exponential backoff (60s → 120s → 240s → ...), capped at
   *  30 minutes. A success resets the consecutive-open count. */
  private readonly recentFailures = new Map<string, number[]>();
  private readonly consecutiveOpens = new Map<string, number>();
  private static readonly CB_WINDOW_MS = 60_000;
  private static readonly CB_THRESHOLD = 5;
  private static readonly CB_BASE_MS = 60_000;
  private static readonly CB_MAX_MS = 30 * 60 * 1000;

  /** Record a failure with a proper sliding window. Prunes failures
   * older than CB_WINDOW_MS, then checks if the remaining count exceeds
   * CB_THRESHOLD. Returns the breaker deadline if tripped, else null. */
  recordFailure(name: string): number | null {
    const entry = this.state.get(name);
    if (!entry) return null;
    const now = Date.now();
    const failures = this.recentFailures.get(name) ?? [];
    failures.push(now);
    const cutoff = now - ProviderStateMap.CB_WINDOW_MS;
    while (failures.length > 0 && failures[0] < cutoff) failures.shift();
    this.recentFailures.set(name, failures);

    if (failures.length < ProviderStateMap.CB_THRESHOLD) return null;

    const openCount = this.consecutiveOpens.get(name) ?? 0;
    const cooldown = Math.min(
      ProviderStateMap.CB_BASE_MS * Math.pow(2, openCount),
      ProviderStateMap.CB_MAX_MS,
    );
    const deadline = now + cooldown;
    entry.breakerUntil = deadline;
    this.consecutiveOpens.set(name, openCount + 1);
    return deadline;
  }

  /** Called on success — clears the recent-failure list and resets the
   *  consecutive-open count so the next trip starts at BASE_MS again. */
  clearFailures(name: string): void {
    this.recentFailures.delete(name);
    this.consecutiveOpens.delete(name);
  }

  /** Snapshot of every registered provider's state for stats/UI. */
  snapshot(): Record<string, {
    active: number;
    queued: number;
    maxConcurrent: number;
    coolingUntil: number | null;
    breakerUntil: number | null;
    rpmLimit: number | null;
    rpmTokens: number | null;
    cooldownFallbackMs: number | null;
  }> {
    const result: Record<string, any> = {};
    for (const [name, entry] of this.state) {
      this.refillTokens(entry);
      result[name] = {
        active: entry.active,
        queued: entry.queued,
        maxConcurrent: entry.maxConcurrent,
        coolingUntil: entry.coolingUntil,
        breakerUntil: entry.breakerUntil,
        rpmLimit: entry.rpmLimit,
        rpmTokens: entry.rpmLimit !== null ? Math.max(0, Math.round(entry.rpmTokens * 100) / 100) : null,
        cooldownFallbackMs: entry.cooldownFallbackMs,
      };
    }
    return result;
  }

  /** All registered provider names. */
  get names(): string[] {
    return [...this.state.keys()];
  }

  /** Per-provider consecutive failure count for exponential circuit
   * breaker backoff. Reset on success. */
  private readonly failureCounts = new Map<string, number>();

  /** Increment the queue depth counter for a provider. Called when a
   * request enters the global queue targeting this provider. */
  incrementQueued(name: string): void {
    const entry = this.state.get(name);
    if (entry) entry.queued++;
  }

  /** Decrement the queue depth counter for a provider. Called when a
   * request leaves the global queue (either to execute or to be removed). */
  decrementQueued(name: string): void {
    const entry = this.state.get(name);
    if (entry) entry.queued = Math.max(0, entry.queued - 1);
  }
}

const CircuitBreakerBaseMs = 60_000;
const CircuitBreakerMaxMs = 30 * 60 * 1000;
