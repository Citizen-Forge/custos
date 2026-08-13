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
 *
 * Types under ./provider-state/types.ts. The ProviderStateMap class itself
 * -- same shape as GlobalQueue/ThrottledProvider -- stays whole: every
 * method reads and mutates the same shared `state`/`recentFailures`/
 * `consecutiveOpens` maps in one tightly-coupled unit, so splitting it
 * further would just move that coupling across file boundaries.
 */
import type { ProviderStateEntry, ProviderStateInit, ProviderUnavailableListener, ProviderAvailableListener } from "./provider-state/types.js";

export type { ProviderStateEntry, ProviderStateInit, ProviderUnavailableListener, ProviderAvailableListener } from "./provider-state/types.js";

/** Applied by `markCooling` when neither the upstream's Retry-After nor a
 *  per-provider `cooldownFallbackMs` is available. Without this, a
 *  provider with no `cooldownFallbackMs` configured (e.g. Groq, whose TPM
 *  rate limit rides in on an HTTP 413 with no Retry-After header) never
 *  actually cools down on a ProviderUnavailableError -- `canAccept` keeps
 *  returning true and the next request hits the same exhausted provider
 *  again immediately. 60s matches Groq's TPM window (limits reset every
 *  minute) and the cooldown-fallback value already used for Ollama. */
const DEFAULT_COOLDOWN_MS = 60_000;

export class ProviderStateMap {
  private readonly state = new Map<string, ProviderStateEntry>();
  /** Subscribers called from `markCooling` and `recordSuccess`. Plain Sets
   *  rather than EventEmitter: there's no scenario where the runtime
   *  benefits from `emit`-style fan-out and the cost of an EventEmitter is
   *  a non-trivial separator between two distinct concerns (state mutation
   *  vs. observer notification). Listeners are kept off the hot path by
   *  being invoked synchronously without try/catch — the model-registry
   *  functions are `void`-returning among the callers we wire today, so a
   *  throwing listener is a real bug, not a network blip. */
  private readonly unavailableListeners = new Set<ProviderUnavailableListener>();
  private readonly availableListeners = new Set<ProviderAvailableListener>();

  /** Subscribe to provider-unavailable events. Returns an unsubscribe
   *  function so callers can clean up across config reloads (the runtime
   *  re-registers on every `reload()`; the old set ref-counts keep the
   *  registry listeners alive otherwise). */
  onUnavailable(listener: ProviderUnavailableListener): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  /** Subscribe to provider-available events. Same return contract as
   *  `onUnavailable`. */
  onAvailable(listener: ProviderAvailableListener): () => void {
    this.availableListeners.add(listener);
    return () => this.availableListeners.delete(listener);
  }

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
      }
      if (init?.cooldownFallbackMs !== undefined) existing.cooldownFallbackMs = init.cooldownFallbackMs;
      return;
    }
    this.state.set(name, {
      coolingUntil: null,
      breakerUntil: null,
      maxConcurrent: init?.maxConcurrent ?? 0,
      active: 0,
      queuedInteractive: 0,
      queuedBackground: 0,
      rpmLimit: init?.rpmLimit ?? null,
      // Ready immediately -- a freshly registered/idle provider shouldn't
      // have to wait out a spacing interval before its first request.
      nextRpmSlotAt: Date.now(),
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

  /** Check if a provider can accept a request right now. Returns true if
   * all gates pass (not cooling, not circuit-broken, under concurrency cap,
   * RPM spacing interval elapsed). This is a read-only check — does NOT
   * consume anything. */
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
    // RPM gate: the next slot hasn't opened yet.
    if (entry.rpmLimit !== null && now < entry.nextRpmSlotAt) return false;
    return true;
  }

  /** Atomically acquire a slot for a provider. Must be preceded by a
   * canAccept() check, or the promise will reject. Returns a release
   * function that the caller MUST call in a finally block. */
  acquire(name: string): () => void {
    const entry = this.state.get(name);
    if (!entry) throw new Error(`Provider "${name}" is not registered`);
    entry.active++;
    if (entry.rpmLimit !== null) {
      const now = Date.now();
      const spacingMs = 60_000 / entry.rpmLimit;
      // max(now, nextRpmSlotAt): if the schedule fell behind wall-clock
      // (the provider sat idle past its last scheduled slot), the next
      // spacing interval counts from now, not from some stale past slot
      // -- otherwise a long-idle provider would let a whole backlog of
      // "already past due" slots through at once, which is exactly the
      // burst behavior this replaced the token bucket to avoid.
      entry.nextRpmSlotAt = Math.max(now, entry.nextRpmSlotAt) + spacingMs;
    }
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
   * (per-provider config) → null (caller's default). When the cooldown
   * record actually lands (was non-null and produced a new effectiveMs),
   * every unavailable-listener fires so the model registry can mirror
   * the unavailable window onto the per-provider records. The listener
   * is invoked synchronously after the state mutation so a subsequent
   * `snapshot()` call sees the new deadline even if the listener awaits
   * a Promise resolution (the registry writes are fire-and-forget). */
  markCooling(name: string, retryAfterMs?: number | null, fallbackMs?: number | null): void {
    const entry = this.state.get(name);
    if (!entry) return;
    const effectiveMs = retryAfterMs ?? fallbackMs ?? DEFAULT_COOLDOWN_MS;
    entry.coolingUntil = Date.now() + Math.max(1000, effectiveMs);
    const reason = retryAfterMs !== null && retryAfterMs !== undefined
      ? "upstream retry-after"
      : fallbackMs !== null && fallbackMs !== undefined
        ? "per-provider cooldown fallback"
        : "default cooldown";
    for (const listener of this.unavailableListeners) listener(name, Math.max(1000, effectiveMs), reason);
  }

  /** Record a successful request — clears any active circuit breaker
   * state for this provider (breakerUntil, recent failures, and the
   * consecutive-open count so the next trip starts at BASE_MS again).
   * Fires every available-listener so the model registry can drop a
   * cooldown early: a successful completion is proof the window
   * reopened, whatever the upstream's reset headers said. Only fires
   * when the success is meaningful for the cooling surface — meaning
   * either the breaker was open or the provider was actively cooling
   * before this success — to avoid spamming the persistence layer on
   * every routine completion. */
  recordSuccess(name: string): void {
    const entry = this.state.get(name);
    if (!entry) return;
    const wasActive = entry.breakerUntil !== null || entry.coolingUntil !== null;
    entry.breakerUntil = null;
    this.clearFailures(name);
    if (wasActive) for (const listener of this.availableListeners) listener(name);
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
    queuedInteractive: number;
    queuedBackground: number;
    maxConcurrent: number;
    coolingUntil: number | null;
    breakerUntil: number | null;
    rpmLimit: number | null;
    /** ms epoch of the next admissible request, or null when rpmLimit is
     *  unset. May be in the past (no request has come in since the last
     *  slot opened) -- callers wanting "is it ready right now" compare
     *  against Date.now() themselves rather than this baking in a
     *  snapshot-time boolean that could go stale between the call and
     *  the caller reading it. */
    rpmReadyAt: number | null;
    cooldownFallbackMs: number | null;
  }> {
    const result: Record<string, any> = {};
    for (const [name, entry] of this.state) {
      result[name] = {
        active: entry.active,
        queuedInteractive: entry.queuedInteractive,
        queuedBackground: entry.queuedBackground,
        maxConcurrent: entry.maxConcurrent,
        coolingUntil: entry.coolingUntil,
        breakerUntil: entry.breakerUntil,
        rpmLimit: entry.rpmLimit,
        rpmReadyAt: entry.rpmLimit !== null ? entry.nextRpmSlotAt : null,
        cooldownFallbackMs: entry.cooldownFallbackMs,
      };
    }
    return result;
  }

  /** All registered provider names. */
  get names(): string[] {
    return [...this.state.keys()];
  }

  /** Increment the queue depth counter for a provider. Called when a
   * request enters the global queue targeting this provider. The priority
   * is passed so `runtime.stats()` can report interactive vs background
   * depths separately, which `runtime-stats.ts`'s alert rules read
   * off the ThrottleStats shape (a per-provider breakdown that the
   * router-era code maintained via independent ThrottledProvider
   * wrappers; the global queue preserves the same shape via this
   * split). */
  incrementQueued(name: string, priority: "interactive" | "background"): void {
    const entry = this.state.get(name);
    if (!entry) return;
    if (priority === "interactive") entry.queuedInteractive++;
    else entry.queuedBackground++;
  }

  /** Decrement the queue depth counter for a provider. Priority matches
   * the increment call -- they're symmetric. */
  decrementQueued(name: string, priority: "interactive" | "background"): void {
    const entry = this.state.get(name);
    if (!entry) return;
    if (priority === "interactive") entry.queuedInteractive = Math.max(0, entry.queuedInteractive - 1);
    else entry.queuedBackground = Math.max(0, entry.queuedBackground - 1);
  }
}
