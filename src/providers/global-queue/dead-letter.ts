// The queue's operator-facing record of dropped work -- a fixed-size FIFO
// ring buffer, extracted out of GlobalQueue because it's genuinely
// self-contained (push + bounded-snapshot) even though the queue itself is
// mostly one cohesive dispatch mechanism that doesn't split cleanly.
import type { FallbackTarget, QueueContext } from "./types.js";
import type { Priority } from "../types.js";

/** Maximum number of dropped / timed-out entries retained in memory
 *  for the admin endpoint to read. 50 keeps the buffer well under
 *  100KB even with the full fallback chain captured per entry, so it
 *  can stay in-process rather than getting paged to disk at this size.
 *  Old entries are shifted off the front (FIFO) when the cap is hit —
 *  recent overflow is the operator's most useful diagnostic signal,
 *  so the newest N always win over the historical oldest. */
const DEAD_LETTER_CAP = 50;

/** Why the entry landed in the dead-letter buffer. Today only
 *  `"timeout"` is fired by `enqueue()`'s onTimeout callback; future
 *  extensions (admin-cancelled, abortAll-on-reload shedding an
 *  outstanding entry, priority demotion) extend this union without
 *  breaking existing readers that switch on the literal. */
export type DeadLetterReason = "timeout";

/** Operator-facing record of work that the queue dropped because it sat
 *  parked longer than the enqueue deadline. Stored in a fixed-size
 *  in-memory ring buffer; surfaced via `GlobalQueue.deadLettersSnapshot()`
 *  for the admin endpoint to render so operators can identify THE
 *  specific stuck request, not just the fact that something is stuck.
 *  The full message body is intentionally not captured: at 50 entries
 *  the cost adds up faster than the diagnostic value, and the
 *  `requestId` lets the admin panel join back into either the
 *  activity log (for event history) or the originating /v1/messages
 *  handler log (for the request body) when an operator wants that. */
export interface DeadLetterEntry {
  requestId: string;
  /** ms epoch at which the timeout fired and the entry was dropped. */
  timestamp: number;
  /** ms epoch at which `enqueue()` first parked the request. */
  queuedAt: number;
  /** timestamp - queuedAt so the operator sees the wait at a glance. */
  waitMs: number;
  fallbackTargets: FallbackTarget[];
  priority: Priority;
  reason: DeadLetterReason;
  /** Caller context (project/agent) carried through enqueue so the
   *  admin endpoint can attribute the stuck request to its origin
   *  row without a join. Mirrors the field of the same name in
   *  QueueActivityEvent but lives in the snapshot view rather than
   *  the event stream. */
  context?: QueueContext;
}

export class DeadLetterBuffer {
  private readonly entries: DeadLetterEntry[] = [];

  /** Push one entry onto the ring buffer; if the cap is reached, shift
   *  the oldest off the front so the most recent overflow stays visible
   *  to the operator. */
  push(entry: DeadLetterEntry): void {
    this.entries.push(entry);
    if (this.entries.length > DEAD_LETTER_CAP) {
      this.entries.shift();
    }
  }

  /** Defensive copy so admin-panel code can iterate, filter, or even
   *  hand-edit the array without leaking references into the buffer's
   *  own bookkeeping. Order is insertion-order (newest-last); callers
   *  that prefer newest-first should reverse the result client-side. */
  snapshot(): readonly DeadLetterEntry[] {
    return this.entries.slice();
  }
}
