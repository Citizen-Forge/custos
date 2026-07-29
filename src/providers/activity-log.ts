/**
 * Activity log for the global queue.
 *
 * A bounded ring buffer of dispatch events that the admin UI surfaces so
 * operators can see what work is actually being pushed through which
 * provider. The runtime is single-threaded JS so there is no concurrency
 * concern; we only trim the buffer when it overflows.
 *
 * Each event is one moment in a request's dispatch lifecycle:
 *   - "queued" — no provider in the fallback set was available; the
 *     request is parked until a slot frees up.
 *   - "dispatched" — the queue acquired a slot on a provider and called
 *     `provider.complete()`. The provider+model here are the chain
 *     entry the queue picked.
 *   - "fallback" — the provider we just dispatched to returned
 *     ProviderUnavailableError; the queue is moving to the next entry
 *     in the fallback set. The provider+model are the one that failed.
 *   - "succeeded" — the dispatched provider returned a successful
 *     response. This is the last event for the request.
 *   - "failed" — every chain entry failed (or a non-availability error
 *     escaped). The error message is the upstream's last word.
 *
 * Events for the same logical request share a `requestId` so the UI can
 * group them. The ring buffer is bounded to MAX_EVENTS so a long-running
 * gateway doesn't accumulate unbounded state; older events are dropped.
 */

export type QueueActivityOutcome =
  | "queued"
  | "dispatched"
  | "fallback"
  | "succeeded"
  | "failed";

/** Shape passed to `record()`. Identical to the event itself except
 *  `id` is optional (the log generates one if absent). Splitting the
 *  input type from the stored type lets the caller supply any subset
 *  of optional fields without having to fill in a placeholder id. */
export type QueueActivityEventInput = Omit<QueueActivityEvent, "id"> & { id?: string };

export interface QueueActivityEvent {
  /** Unique per event. Distinct events for the same logical request share
   *  a `requestId` instead. */
  id: string;
  /** Groups all events for one logical request. Set when the queue
   *  accepts a call into `complete()`; propagated onto every subsequent
   *  event the queue emits for that call. */
  requestId: string;
  /** ms epoch. */
  timestamp: number;
  /** Optional caller context (project + agent) — present when the
   *  dispatcher knew who was making the request, null otherwise. */
  projectId?: string;
  projectName?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  /** Fallback set name being routed through. Always present for events
   *  emitted by GlobalQueue.complete(). */
  fallbackSet?: string;
  /** Provider the queue attempted to dispatch to (or was about to, for
   *  `queued`). May be missing on `failed` when no entry was even
   *  checkable. */
  provider?: string;
  model?: string;
  outcome: QueueActivityOutcome;
  /** ms epoch when the request first entered the queue. Set on the
   *  first event for a requestId and copied onto subsequent events so
   *  the UI can compute duration without a join. */
  queuedAt?: number;
  /** Computed duration = timestamp - queuedAt, attached for convenience
   *  on terminal events (succeeded/failed). */
  durationMs?: number;
  /** Set on `failed` and on `fallback` (where it explains why we're
   *  moving to the next entry). Truncated to a reasonable length. */
  errorMessage?: string;
}

export interface DispatchContext {
  projectId?: string;
  projectName?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  fallbackSet?: string;
  /** Routing discriminator: how this request entered the GlobalQueue.
   *  Makes the activity panel able to group events by route shape
   *  (pinned / fallback / general) without having to thread it through
   *  from `x-custos-*` response headers. The queue's recordEvent
   *  spreads DispatchContext onto every event it emits, so adding the
   *  field here is enough — no changes needed to ActivityLog. */
  route?: "pinned" | "fallback" | "general";
}

const MAX_EVENTS = 200;
const ERROR_MESSAGE_MAX = 240;

let nextId = 0;
function freshId(): string {
  nextId = (nextId + 1) & 0xffffffff;
  return `qa-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export class ActivityLog {
  private events: QueueActivityEvent[] = [];

  /** Record a single event. Trims `errorMessage` and applies the
   *  bounded-buffer cap. Cheap; safe to call from any code path. */
  record(input: QueueActivityEventInput): QueueActivityEvent {
    const event: QueueActivityEvent = {
      id: input.id ?? freshId(),
      requestId: input.requestId,
      timestamp: input.timestamp,
      outcome: input.outcome,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.fallbackSet !== undefined ? { fallbackSet: input.fallbackSet } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: input.errorMessage.slice(0, ERROR_MESSAGE_MAX) }
        : {}),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    return event;
  }

  /** Return the most recent events, newest first. `limit` is clamped
   *  to the buffer size; passing 0 returns everything. */
  recent(limit: number): QueueActivityEvent[] {
    if (limit <= 0 || limit >= this.events.length) {
      return this.events.slice().reverse();
    }
    return this.events.slice(this.events.length - limit).reverse();
  }

  /** Wipe the buffer. Used by the admin endpoint to reset the panel. */
  clear(): void {
    this.events.length = 0;
  }

  /** Current size, useful for tests and the UI's "showing N of M" line. */
  get size(): number {
    return this.events.length;
  }

  /** Cap exposed for tests and for the admin endpoint so the panel can
   *  show "showing last 50 of 200". */
  static get capacity(): number {
    return MAX_EVENTS;
  }
}