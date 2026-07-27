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

import type { Provider, CompleteOptions, ProviderResponse, Priority } from "./types.js";
import type { AnthropicMessagesRequest } from "../types.js";

/** Default age at which a still-queued background request is treated as
 * equivalent to interactive for one slot. Five seconds is short enough
 * that a stalled curator doesn't fall behind multiple turns of chat
 * traffic, and long enough that hobbyist chat bursts don't preempt
 * well-formed background work. Pass `priorityAgedMs: 0` to disable. */
const DEFAULT_AGED_MS = 5_000;

function isError(v: unknown): v is Error {
  return typeof v === "object" && v !== null && v instanceof Error;
}

function combineSignals(primary: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  if (!primary) return fallback;
  // If primary is already aborted, the combined signal should be too.
  // AbortSignal listeners do NOT replay retroactively, so any listener
  // we'd attach below would silently never fire -- the caller has to
  // observe the signal as already aborted.
  if (primary.aborted) {
    return primary;
  }
  // Same retroactive-listener trap applies symmetrically to fallback:
  // abortAll() can synchronously abort an internalController pushed
  // for a queued entry BEFORE runWithSlotAsync resumes and reaches
  // this function. Without the early-return, the listener we'd attach
  // would silently never fire, leaving the inner Promise pending.
  if (fallback.aborted) {
    return fallback;
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  primary.addEventListener("abort", onAbort, { once: true });
  fallback.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", () => {
    primary.removeEventListener("abort", onAbort);
    fallback.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}

/** Per-throttle load snapshot. Returned by `ThrottledProvider.stats()` and
 * folded into RuntimeStats by the runtime; the same shape gets logged
 * periodically and surfaced through the admin stats endpoint so all
 * monitoring surfaces (UI, log scraper, alert rule) consume one
 * canonical schema. */
export interface ThrottleStats {
  /** Provider name (matches the key in `openaiCompatibleInstances`, or
   * "anthropic" for the wrapped Anthropic provider). */
  name: string;
  /** Currently in-flight requests. */
  active: number;
  /** Sub-queue depth for interactive requests. */
  queuedInteractive: number;
  /** Sub-queue depth for background requests. */
  queuedBackground: number;
  /** Sum of both buckets -- equivalent to the old `queued` getter. */
  queuedTotal: number;
  /** Configured slot cap. 0 means "not throttled" (no ThrottledProvider
   * wrap), in which case `slotsUtilization` is also 0. */
  maxConcurrent: number;
  /** `active / maxConcurrent`, in [0, 1]. 0 when not throttled. */
  slotsUtilization: number;
}

export interface ThrottleOptions {
  /** Max in-flight requests this provider will handle simultaneously.
   * 1 forces strict serial (useful for single-shot local models). */
  maxConcurrent: number;
  /** Wall-clock ms after which a still-queued background request is
   * promoted to "fairly-due" and jumps ahead of fresh interactive
   * requests in the next pump() pass. Default 5000. Set to 0 to
   * disable aging (strict, never-aging priority). */
  priorityAgedMs?: number;
}

interface PendingEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  aborted: boolean;
  priority: Priority;
  /** Wall-clock ms from `Date.now()` at queue-push time. Used by
   * pump() to detect aged background entries. */
  queuedAt: number;
}

export class ThrottledProvider implements Provider {
  readonly name: string;
  private readonly inner: Provider;
  private readonly slots: number;
  private readonly agedMs: number;
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
    this.inner = inner;
    this.name = inner.name;
    this.slots = options.maxConcurrent;
    this.agedMs = options.priorityAgedMs ?? DEFAULT_AGED_MS;
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
      // 0 means "provider isn't throttled, no ratio meaningful" -- the
      // shape always includes the field so the JSON consumer doesn't
      // have to special-case missing keys.
      slotsUtilization: this.slots > 0 ? this.inFlight / this.slots : 0,
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
    } finally {
      const i = this.inFlightControllers.indexOf(internalController);
      if (i !== -1) this.inFlightControllers.splice(i, 1);
      this.releaseSlot();
    }
  }

  private acquireSlot(signal: AbortSignal | undefined, priority: Priority): Promise<void> {
    if (this.inFlight < this.slots) {
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
        const reason: unknown = signal.reason;
        if (isError(reason)) reject(reason);
        else if (typeof reason === "string") reject(new Error(reason));
        else reject(new Error("aborted"));
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
    while (this.inFlight < this.slots) {
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
