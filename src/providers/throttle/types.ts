import type { Priority } from "../types.js";

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
  /** Requests-per-minute limit. null when no rate limit is configured. */
  rpmLimit: number | null;
  /** Current token-bucket level. Starts at `rpmLimit` and decrements on
   * each admitted request, refilling continuously (at `rpmLimit/60` per
   * second). Null when no rate limit is set. */
  rateTokens: number | null;
}

export interface ThrottleOptions {
  /** Max in-flight requests this provider will handle simultaneously.
   * 1 forces strict serial (useful for single-shot local models). */
  maxConcurrent: number;
  /** Requests-per-minute cap. When set, the throttle admits at most this
   * many requests per minute using a token-bucket algorithm, proactively
   * queuing requests that would exceed the rate instead of only reacting
   * to 429s. Set to 10 for Gemini Free. Unset means no rate limit. */
  rpmLimit?: number;
  /** Wall-clock ms after which a still-queued background request is
   * promoted to "fairly-due" and jumps ahead of fresh interactive
   * requests in the next pump() pass. Default 5000. Set to 0 to
   * disable aging (strict, never-aging priority). */
  priorityAgedMs?: number;
}

export interface PendingEntry {
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
