// Per-provider concurrency limiter.
//
// Decorator over an existing Provider that FIFO-queues requests above
// the configured slot limit and releases a slot whenever the inner call
// settles -- success or failure. Wrapping the provider (rather than
// adding the limit inside ProviderRouter) keeps the routing policy in
// router.ts and the concurrency policy in this file cleanly separated:
// every call site of `provider.complete()` -- the router, direct
// invocations, future ones -- gets the same throttle without each
// caller having to remember.
//
// AbortSignal-aware by design:
//   * A queued entry's signal aborting removes the entry from the queue
//     without consuming a slot. Aborting should never spend capacity the
//     caller no longer wants.
//   * An in-flight entry's signal aborting passes through to the inner
//     provider's fetch abort handling. The slot still releases on
//     inner.complete settling, via try/finally.
//
// Provider-awareness doesn't need special code here: each
// ThrottledProvider instance has its own slot counter and its own queue,
// so a saturated Ollama doesn't hold up a free Anthropic. The router
// iterates its priority list; if ollama's queue is full, the call waits
// inside the ThrottledProvider for ollama, not at the gateway level.
// When ollama is unavailable (server down) the router falls through to
// the next priority entry as it does today.

import type { Provider, CompleteOptions, ProviderResponse } from "./types.js";
import type { AnthropicMessagesRequest } from "../types.js";

/** Runtime "is this an Error" guard. Acts as a type guard so a TS2358
 * (`unknown instanceof Error`) site can be replaced with `isError(v)`
 * and narrow correctly. Direct `unknown instanceof Error` is rejected
 * by tsc; narrowing to `object` first is enough to satisfy TS2358
 * (which permits `any`, `object`, or a type parameter on the LHS). */
function isError(v: unknown): v is Error {
  return typeof v === "object" && v !== null && v instanceof Error;
}

/** Combine two AbortSignals into one that aborts when either does.
 * `initializeFallback` fires synchronously if the primary is already
 * aborted at construction time, mirroring the behavior the consumer
 * would expect from a normal AbortSignal. */
function combineSignals(primary: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  if (!primary) return fallback;
  // If primary is already aborted, the combined signal should be too.
  if (primary.aborted) {
    // Reuse the fallback's abort semantics without firing a listener
    // on the primary (which would no-op anyway since it's already
    // aborted). We could create a fresh controller and abort it, but
    // returning `primary` is equivalent for this caller -- the
    // downstream fetch on `combined` sees an aborted signal.
    return primary;
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  primary.addEventListener("abort", onAbort, { once: true });
  fallback.addEventListener("abort", onAbort, { once: true });
  // Detach on settle so listeners don't leak past combined's lifetime.
  // combineSignals is called once per runWithSlot so this is small.
  controller.signal.addEventListener("abort", () => {
    primary.removeEventListener("abort", onAbort);
    fallback.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}

export interface ThrottleOptions {
  /** Max in-flight requests this provider will handle simultaneously.
   * 1 forces strict serial (useful for single-shot local models); unset
   * on the wrapped inner (via the wrapper not being constructed at
   * all) means unbounded. */
  maxConcurrent: number;
}

interface PendingEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  aborted: boolean;
}

export class ThrottledProvider implements Provider {
  readonly name: string;
  private readonly inner: Provider;
  private readonly slots: number;
  private readonly pending: PendingEntry[] = [];
  /** One AbortController per in-flight call. Each entry in `pending` is
   * a queued (yet-to-start) submission, so it doesn't have an entry here
   * yet -- only after pump() promotes it. abortAll() iterates these and
   * signals each inner fetch to abort; the slot releases when the inner
   * promise settles. */
  private readonly inFlightControllers: AbortController[] = [];
  private inFlight = 0;

  constructor(inner: Provider, options: ThrottleOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error(`ThrottledProvider: maxConcurrent must be a positive integer, got ${options.maxConcurrent}`);
    }
    this.inner = inner;
    this.name = inner.name;
    this.slots = options.maxConcurrent;
  }

  /** Slots currently occupied. Exposed for tests and for future metrics. */
  get active(): number {
    return this.inFlight;
  }

  /** Requests waiting for a slot. Exposed for tests and for future metrics. */
  get queued(): number {
    return this.pending.length;
  }

  complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse> {
    return this.runWithSlot(request, options);
  }

  private runWithSlot(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse> {
    // Synchronous wrapper before any await: allocate the internal
    // controller and register it so abortAll() -- which Runtime.reload
    // invokes synchronously and which the abortAll tests call from the
    // same sync frame as t.complete() -- can find this controller even
    // when no microtask has flushed yet. Doing the push inside the async
    // body introduced a race: by the time abortAll iterated, the
    // post-await microtask hadn't run, so inFlightControllers was still
    // empty and the inner fetches kept running.
    const callerSignal = options?.signal;
    const internalController = new AbortController();
    this.inFlightControllers.push(internalController);
    return this.runWithSlotAsync(request, options, callerSignal, internalController);
  }

  private async runWithSlotAsync(
    request: AnthropicMessagesRequest,
    options: CompleteOptions | undefined,
    callerSignal: AbortSignal | undefined,
    internalController: AbortController,
  ): Promise<ProviderResponse> {
    await this.acquireSlot(callerSignal);
    // combineSignals is OR over caller + internal signals: either
    // aborting cancels the inner fetch.
    const combined = combineSignals(callerSignal, internalController.signal);
    try {
      return await this.inner.complete(request, { ...options, signal: combined });
    } finally {
      // Slot releases on success AND failure -- a throttled provider
      // should never deadlock because of an inner rejection.
      const i = this.inFlightControllers.indexOf(internalController);
      if (i !== -1) this.inFlightControllers.splice(i, 1);
      this.releaseSlot();
    }
  }

  private acquireSlot(signal: AbortSignal | undefined): Promise<void> {
    if (this.inFlight < this.slots) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, signal, onAbort: undefined, aborted: false };
      this.pending.push(entry);
      if (!signal) return;
      // Attach an abort listener that removes the entry from the queue
      // without consuming a slot. The listener is later detached in
      // `pump()` once the entry actually starts running, at which point
      // the signal is forwarded to the inner provider's fetch and its
      // semantics become the inner provider's responsibility.
      const onAbort = (): void => {
        if (entry.aborted) return;
        entry.aborted = true;
        const i = this.pending.indexOf(entry);
        if (i !== -1) this.pending.splice(i, 1);
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
   * in-flight inner call so it settles promptly. Used by Runtime.reload
   * so a config edit doesn't leave the old throttle quietly continuing
   * to draw upstream capacity on a fresh ThrottledProvider that's
   * already switched shape underneath it.
   *
   * After abortAll the throttle is empty: active=0, queued=0, no
   * listeners attached. It's safe (but pointless) to keep using; the
   * canonical caller drops the instance afterwards. */
  abortAll(reason: string | Error = "throttle reset"): void {
    const err = reason instanceof Error ? reason : new Error(reason);
    for (const entry of this.pending) {
      entry.aborted = true;
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(err);
    }
    this.pending.length = 0;
    for (const ctrl of this.inFlightControllers) ctrl.abort();
  }

  private pump(): void {
    while (this.inFlight < this.slots && this.pending.length > 0) {
      const next = this.pending.shift()!;
      // Race window: the queue had a never-aborted entry at push time,
      // but its abort fired before pump() reached it. Skip -- the abort
      // listener already rejected its promise and removed it from the
      // list, so we shouldn't reach here, but guard anyway.
      if (next.aborted) continue;
      // Detach the abort listener: this entry is now in-flight and the
      // signal is forwarded to the inner provider. The inner provider
      // (e.g. fetch with the signal passed in `options.signal`) handles
      // its own cancellation from here on.
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.inFlight++;
      next.resolve();
    }
  }
}
