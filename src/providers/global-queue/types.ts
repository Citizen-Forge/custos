// Shared types for GlobalQueue and its extracted sub-modules (dead-letter.ts).
import type { AnthropicMessagesRequest } from "../../types.js";
import type { CompleteOptions, Priority, ProviderResponse } from "../types.js";
import type { DispatchContext } from "../activity-log.js";

/** Optional knob set on a per-queue basis. Pass-through to the constructor
 *  for tests; production callers use the defaults. */
export interface GlobalQueueOptions {
  enqueueTimeoutMs?: number;
  enqueueRetryAfterMs?: number;
  /** Enables the periodic safety-net pump sweep (see the constructor) at
   *  this interval. Opt-in, unlike every other option here: a long-lived
   *  recurring timer touching every queue instance's state for the rest
   *  of its life is a fundamentally different risk than a one-shot
   *  per-request setTimeout, and defaulting it on tripped up the test
   *  suite's many existing GlobalQueue instances that deliberately leave
   *  requests queued mid-test to assert on queue depth -- the sweep would
   *  dispatch them out from under the assertion. Production's one real
   *  instance (runtime.ts) passes this explicitly; everything else (every
   *  test) gets no periodic pump at all unless a test opts in itself. */
  periodicPumpIntervalMs?: number;
}

export interface FallbackTarget {
  /** Provider name (key in the providers map). */
  provider: string;
  /** Model to use when dispatching to this provider. Passed as
   * modelOverride in CompleteOptions so the provider uses this model
   * instead of its default. */
  model: string;
}

/** Optional caller context threading through the queue. Carries the
 *  project + agent metadata from the dispatcher (parsed from the alias
 *  suffix or supplied directly by /v1/messages handler), used to
 *  attribute events onto the right row in the admin activity log. */
export type QueueContext = DispatchContext;

export interface QueuedEntry {
  fallbackTargets: FallbackTarget[];
  request: AnthropicMessagesRequest;
  options: CompleteOptions | undefined;
  priority: Priority;
  queuedAt: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  aborted: boolean;
  resolve: (value: ProviderResponse & { providerName: string }) => void;
  reject: (err: Error) => void;
  /** Stamp preserved through enqueue → dispatch so the activity log can
   *  group events for one logical request. */
  requestId: string;
  /** Caller context (project + agent) carried through enqueue. */
  context: QueueContext | undefined;
  /** Wall-clock deadline the queue watches while parked. Cleared (set
   *  to `undefined`) the instant the entry leaves the queue under any
   *  path (dispatch via pump, signal-abort, abortAll on reload, or the
   *  timeout's natural fire). The cleanup paths call clearTimeout
   *  unconditionally — clearTimeout is the runtime's natty cleanup
   *  primitive — so even if the timer's callback is already scheduled,
   *  clearTimeout is a safe no-op and the promise's resolve/reject is
   *  never reached twice. */
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
}
