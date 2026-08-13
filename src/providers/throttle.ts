// Per-provider priority-aware concurrency limiter.
//
// Decorator over an existing Provider that throttles requests to a
// configurable `maxConcurrent` slot count. When the cap is reached,
// additional requests get queued, drained in this order inside the
// throttle:
//
//   1. Wait until a stale background slot is available (older than
//      `priorityAgedMs`). Drain ONE background request before any
//      newer background or interactive requests run. This prevents a
//      sustained interactive stream from starving background forever.
//   2. Otherwise drain interactive before background.
//
// Within each sub-queue, FIFO order is preserved so identical-priority
// requests resolve in the order they were submitted.
//
// Wrapping the provider (rather than adding the limit inside
// ProviderRouter) keeps the routing policy in router.ts and the
// concurrency policy in this file cleanly separated: every call site
// of `provider.complete()` -- the router, direct invocations, future
// ones -- gets the same throttle without each caller having to
// remember.
//
// AbortSignal-aware by design:
//   * A queued entry's signal aborting removes the entry from the
//     queue (interactive or background) without consuming a slot.
//     Aborting should never spend capacity the caller no longer wants.
//   * An in-flight entry's signal aborting passes through to the inner
//     provider's fetch abort handling. The slot still releases on
//     inner.complete settling, via try/finally.
//
// Provider-awareness doesn't need special code here: each
// ThrottledProvider instance has its own slot counter and its own
// queues, so a saturated Ollama doesn't hold up a free Anthropic.
//
// Split like GlobalQueue (see global-queue.ts): the pure pieces --
// types under ./throttle/types.ts, the combineSignals helper under
// ./throttle/helpers.ts -- live in their own files, but the
// ThrottledProvider class itself stays whole. Its methods
// (acquireSlot/releaseSlot/pump/pickNext/runWithSlot) all read and
// mutate the same in-flight/queue/token-bucket state in one
// tightly-sequenced dispatch flow; splitting that further would just
// move the coupling across file boundaries instead of reducing it.

import type { Provider, CompleteOptions, ProviderResponse, Priority } from "./types.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import { abortErrorFromSignal } from "./abort-utils.js";
import { combineSignals } from "./throttle/helpers.js";
import type { ThrottleStats, ThrottleOptions, PendingEntry } from "./throttle/types.js";

export type { ThrottleStats, ThrottleOptions } from "./throttle/types.js";

/** Default age at which a still-queued background request is treated as
 * equivalent to interactive for one slot. Five seconds is short enough
 * that a stalled curator doesn't fall behind multiple turns of chat
 * traffic, and long enough that hobbyist chat bursts don't preempt
 * well-formed background work. Pass `priorityAgedMs: 0` to disable. */
const DEFAULT_AGED_MS = 5_000;

export class ThrottledProvider implements Provider {
  readonly name: string;
  private readonly inner: Provider;
  private readonly slots: number;
  private readonly agedMs: number;
  /** Requests-per-minute token-bucket limit. null = unlimited. */
  private readonly rpmLimit: number | null;
  /** Current token count. Starts at rpmLimit and refills continuously. */
  private rateTokens: number;
  /** Last refill timestamp in ms epoch, used to compute token refill. */
  private lastRefill: number;
  /** Sub-queues keyed by priority. Pump() drains interactive first,
   * unless a stale background entry is at the head of the background
   * queue (the anti-starvation aging). */
  private readonly interactivePending: PendingEntry[] = [];
  private readonly backgroundPending: PendingEntry[] = [];
  /** One AbortController per in-flight call. abortAll() iterates these
   * and signals each inner fetch to abort; the slot releases when the
   * inner promise settles. */
  private readonly inFlightControllers: AbortController[] = [];
  private inFlight = 0;

  constructor(inner: Provider, options: ThrottleOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error(`ThrottledProvider: maxConcurrent must be a positive integer, got ${options.maxConcurrent}`);
    }
    if (options.priorityAgedMs !== undefined && (!Number.isFinite(options.priorityAgedMs) || options.priorityAgedMs < 0)) {
      throw new Error(`ThrottledProvider: priorityAgedMs must be a non-negative number, got ${options.priorityAgedMs}`);
    }
    if (options.rpmLimit !== undefined && (!Number.isInteger(options.rpmLimit) || options.rpmLimit < 1)) {
      throw new Error(`ThrottledProvider: rpmLimit must be a positive integer, got ${options.rpmLimit}`);
    }
    this.inner = inner;
    this.name = inner.name;
    this.slots = options.maxConcurrent;
    this.agedMs = options.priorityAgedMs ?? DEFAULT_AGED_MS;
    this.rpmLimit = options.rpmLimit ?? null;
    this.rateTokens = this.rpmLimit ?? 0;
    this.lastRefill = Date.now();
  }

  /** Slots currently occupied. */
  get active(): number {
    return this.inFlight;
  }

  /** Total queued requests across both priority buckets. */
  get queued(): number {
    return this.interactivePending.length + this.backgroundPending.length;
  }

  /** Total queued for a specific priority bucket. Useful for metrics
   * and for tests that want to assert a specific bucket's depth
   * without conflating the two. */
  queuedFor(priority: Priority): number {
    return priority === "interactive" ? this.interactivePending.length : this.backgroundPending.length;
  }

  /** Refill the token bucket based on elapsed time since last refill. */
  private refillTokens(): void {
    if (this.rpmLimit === null) return;
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    // Refill at a rate of rpmLimit tokens per 60 seconds.
    const add = (elapsedMs / 60_000) * this.rpmLimit;
    this.rateTokens = Math.min(this.rpmLimit, this.rateTokens + add);
    this.lastRefill = now;
  }

  /** Try to consume a rate-limit token. Returns true if a token was
   * available and consumed, false otherwise. Always returns true when
   * no rate limit is configured. */
  private tryConsumeToken(): boolean {
    this.refillTokens();
    if (this.rpmLimit === null) return true;
    if (this.rateTokens < 1) return false;
    this.rateTokens -= 1;
    return true;
  }

  /** Snapshot of this throttle's current load, in a shape the runtime
   * stats surface (and any external monitoring) can consume without
   * poking at internal getters one field at a time. Safe to call on
   * any throttled provider; returns 0/empty values when idle. */
  stats(): ThrottleStats {
    const queuedInteractive = this.interactivePending.length;
    const queuedBackground = this.backgroundPending.length;
    return {
      name: this.name,
      active: this.inFlight,
      queuedInteractive,
      queuedBackground,
      queuedTotal: queuedInteractive + queuedBackground,
      maxConcurrent: this.slots,
      slotsUtilization: this.slots > 0 ? this.inFlight / this.slots : 0,
      rpmLimit: this.rpmLimit,
      rateTokens: this.rpmLimit !== null ? Math.max(0, Math.round(this.rateTokens * 100) / 100) : null,
    };
  }

  complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse> {
    return this.runWithSlot(request, options);
  }

  private runWithSlot(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse> {
    // Synchronous wrapper before any await: allocate the internal
    // controller and register it so abortAll() can find this controller
    // even when no microtask has flushed yet.
    const callerSignal = options?.signal;
    const priority: Priority = options?.priority ?? "interactive";
    const internalController = new AbortController();
    this.inFlightControllers.push(internalController);
    return this.runWithSlotAsync(request, options, callerSignal, priority, internalController);
  }

  private async runWithSlotAsync(
    request: AnthropicMessagesRequest,
    options: CompleteOptions | undefined,
    callerSignal: AbortSignal | undefined,
    priority: Priority,
    internalController: AbortController,
  ): Promise<ProviderResponse> {
    await this.acquireSlot(callerSignal, priority);
    const combined = combineSignals(callerSignal, internalController.signal);
    try {
      // Forward priority so downstream re-entry (e.g. a ThrottledProvider
      // wrapping another ThrottledProvider) preserves the bucket. In
      // practice the inner is an OpenAI/Anthropic provider directly,
      // so this is a no-op for the wired-up shape, but the pattern is
      // safe even if the wrapping depth grows.
      return await this.inner.complete(request, { ...options, signal: combined, priority });
    } catch (err) {
      // Refund the rate-limit token when the upstream rejected with a
      // 429 / 503 signal (ProviderUnavailableError). The call did NOT
      // consume rate-limit quota from the upstream's perspective —
      // the gateway's local token bucket shouldn't penalize the next
      // caller by holding capacity for a request the upstream said
      // didn't count. Without this refund, a sustained outage drains
      // the bucket to zero while upstream is recovering, so even
      // after the cooldown expires the next batch of requests stays
      // queued behind an empty token bucket and the user experiences
      // a long stall. Other error classes (network errors, 4xx
      // payload rejections) are NOT refunded: those calls genuinely
      // hit the wire and invalidated whatever upstream capacity they
      // were probing.
      if (err instanceof ProviderUnavailableError && this.rpmLimit !== null) {
        this.rateTokens = Math.min(this.rpmLimit, this.rateTokens + 1);
      }
      throw err;
    } finally {
      const i = this.inFlightControllers.indexOf(internalController);
      if (i !== -1) this.inFlightControllers.splice(i, 1);
      this.releaseSlot();
    }
  }

  private acquireSlot(signal: AbortSignal | undefined, priority: Priority): Promise<void> {
    // Check both concurrency AND rate limit. If either is exhausted,
    // queue the request. Rate tokens are consumed atomically with the
    // slot assignment so we never admit a request that can't run.
    if (this.inFlight < this.slots && this.tryConsumeToken()) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const queue = priority === "interactive" ? this.interactivePending : this.backgroundPending;
      const entry: PendingEntry = {
        resolve,
        reject,
        signal,
        onAbort: undefined,
        aborted: false,
        priority,
        queuedAt: Date.now(),
      };
      queue.push(entry);
      if (!signal) return;
      // Attach an abort listener that removes the entry from its
      // bucket without consuming a slot.
      const onAbort = (): void => {
        if (entry.aborted) return;
        entry.aborted = true;
        const i = queue.indexOf(entry);
        if (i !== -1) queue.splice(i, 1);
        reject(abortErrorFromSignal(signal));
      };
      entry.onAbort = onAbort;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    if (this.inFlight > 0) this.inFlight--;
    this.pump();
  }

  /** Drops every queued entry (rejecting its promise) and aborts every
   * in-flight inner call so it settles promptly. Used by Runtime.reload.
   * Iterates both sub-queues so a partially-emptied relaunch doesn't
   * trap an interactive in a queue whose listener was already rejected. */
  abortAll(reason: string | Error = "throttle reset"): void {
    const err = reason instanceof Error ? reason : new Error(reason);
    for (const queue of [this.interactivePending, this.backgroundPending]) {
      for (const entry of queue) {
        entry.aborted = true;
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
        entry.reject(err);
      }
      queue.length = 0;
    }
    for (const ctrl of this.inFlightControllers) ctrl.abort();
  }

  private pump(): void {
    // Refill tokens before checking availability so a burst of releases
    // across multiple poll cycles is handled correctly.
    this.refillTokens();
    while (this.inFlight < this.slots) {
      // Check rate limit: if no tokens available, stop pumping. The
      // remaining queued entries stay queued until a refill or a new
      // acquire call restocks tokens.
      if (this.rpmLimit !== null && this.rateTokens < 1) break;

      const next = this.pickNext();
      if (!next) break;
      // Race window: the abort listener rejected the promise and
      // spliced it from its sub-queue already; pickNext() should
      // not return such an entry, but guard anyway because abort
      // timing is microtask-ordering dependent.
      if (next.aborted) continue;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.inFlight++;
      // Consume a rate token when the request is actually admitted.
      if (this.rpmLimit !== null) this.rateTokens = Math.max(0, this.rateTokens - 1);
      next.resolve();
    }
  }

  /** Pick the next queued entry to start. Returns undefined when both
   * sub-queues are empty.
   *
   * Aging logic: if the head of the background queue has been waiting
   * longer than `agedMs`, this single pass prefers it over any fresh
   * interactive requests. We deliberately do NOT also demote every
   * background, just the head -- a queued chain of aged backgrounds
   * still drains FIFO within their bucket. */
  private pickNext(): PendingEntry | undefined {
    if (this.agedMs > 0 && this.backgroundPending.length > 0) {
      const head = this.backgroundPending[0];
      if (head.queuedAt + this.agedMs <= Date.now()) {
        return this.backgroundPending.shift();
      }
    }
    return this.interactivePending.shift() ?? this.backgroundPending.shift();
  }
}
