/**
 * Global provider-aware queue for LLM requests.
 *
 * Replaces the previous architecture where each provider had its own
 * ThrottledProvider wrapper with independent queues. Now a single global
 * queue manages ALL providers centrally:
 *
 * 1. A request arrives with a fallback set (ordered list of provider
 *    entries, each with name + model).
 * 2. The queue iterates the fallback set in order, checking
 *    ProviderStateMap for each provider's availability (cooldown, breaker,
 *    concurrency, RPM).
 * 3. The first available provider acquires a slot via ProviderStateMap
 *    and the request is dispatched with the entry's model passed as
 *    modelOverride.
 * 4. If a ProviderUnavailableError is thrown, the cooldown is recorded,
 *    and the NEXT entry in the fallback set is tried.
 * 5. If ALL providers fail, the error from the last one is thrown.
 * 6. If NO provider is available at all (every one is cooling/at-capacity),
 *    the request is queued.
 * 7. When a slot frees up, pump() re-checks queued requests.
 *
 * Per-provider limits (concurrency, RPM) are enforced by ProviderStateMap.
 * Queue priority aging prevents background starvation.
 *
 * When an ActivityLog is wired in via the constructor, the queue records
 * queued/dispatched/fallback/succeeded/failed events so the admin panel
 * can show what work is actually flowing through which provider.
 */

import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import type { Provider, CompleteOptions, ProviderResponse, Priority } from "./types.js";
import { ProviderStateMap } from "./provider-state.js";
import { ActivityLog, type DispatchContext } from "./activity-log.js";

const DEFAULT_AGED_MS = 5_000;

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

interface QueuedEntry {
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
}

export class GlobalQueue {
  private readonly interactiveQueue: QueuedEntry[] = [];
  private readonly backgroundQueue: QueuedEntry[] = [];
  private providers: Record<string, Provider>;
  private state: ProviderStateMap;
  private readonly activity: ActivityLog | null;
  private readonly ownActivity: ActivityLog | null;
  private requestCounter = 0;

  constructor(providers: Record<string, Provider>, state: ProviderStateMap, activity?: ActivityLog) {
    this.providers = providers;
    this.state = state;
    if (activity) {
      this.activity = activity;
      this.ownActivity = null;
    } else {
      this.ownActivity = new ActivityLog();
      this.activity = this.ownActivity;
    }
  }

  /** Replace providers map on config reload. */
  setProviders(providers: Record<string, Provider>): void {
    this.providers = providers;
  }

  /** Replace state map reference on config reload. */
  setStateMap(state: ProviderStateMap): void {
    this.state = state;
  }

  /** The ActivityLog recording dispatch events. Always non-null — when
   *  no external log is wired in, the queue owns a private one that the
   *  Runtime can read via `queueActivityLog()` for the admin endpoint. */
  queueActivityLog(): ActivityLog {
    return this.activity!;
  }

  /** Submit a request with a fallback set of { provider, model } pairs.
   * Tries each entry in order; on ProviderUnavailableError falls through
   * to the next. Queues when no provider is available right now. The
   * model from each entry is passed as modelOverride in the options so
   * the provider uses the fallback set's chosen model. The optional
   * `context` carries project + agent metadata used to attribute the
   * activity-log events this call emits. */
  async complete(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
    context?: QueueContext,
  ): Promise<ProviderResponse & { providerName: string }> {
    return this.tryExecute(fallbackTargets, request, options, context, this.freshRequestId());
  }

  /** Try to execute against each entry in the fallback set in order.
   * If a provider throws ProviderUnavailableError, the cooldown is
   * recorded and the next entry is tried. If ALL providers fail,
   * the last error is thrown. If no provider is even checkable (all
   * at capacity/cooldown), the request is queued. The entry's model
   * is passed as modelOverride so the provider uses the fallback set's
   * chosen model rather than its default.
   *
   * `requestId` is supplied by the caller so recursive invocations
   * (the fallback re-queue inside `executeWithRelease`) reuse the
   * original id, keeping every event for one logical request on a
   * single id. A fresh call from `complete()` mints its own. */
  private async tryExecute(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options: CompleteOptions | undefined,
    context: QueueContext | undefined,
    requestId: string,
  ): Promise<ProviderResponse & { providerName: string }> {
    const startedAt = Date.now();
    let lastError: ProviderUnavailableError | undefined;
    let anyAvailable = false;

    for (const entry of fallbackTargets) {
      const provider = this.providers[entry.provider];
      if (!provider) continue;

      // Check availability via ProviderStateMap.
      if (!this.state.canAccept(entry.provider)) continue;
      anyAvailable = true;

      // Merge modelOverride into options so the provider uses the
      // fallback set's chosen model.
      const mergedOptions: CompleteOptions = {
        ...options,
        modelOverride: entry.model,
      };

      // Acquire a slot and dispatch.
      const release = this.state.acquire(entry.provider);
      this.recordEvent({
        requestId,
        timestamp: Date.now(),
        outcome: "dispatched",
        queuedAt: startedAt,
        provider: entry.provider,
        model: entry.model,
        ...context,
      });
      try {
        const response = await provider.complete(request, mergedOptions);
        this.state.recordSuccess(entry.provider);
        this.recordEvent({
          requestId,
          timestamp: Date.now(),
          outcome: "succeeded",
          queuedAt: startedAt,
          provider: entry.provider,
          model: entry.model,
          durationMs: Date.now() - startedAt,
          ...context,
        });
        return { ...response, providerName: entry.provider };
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          lastError = err;
          this.state.markCooling(entry.provider, err.retryAfterMs, this.state.get(entry.provider)?.cooldownFallbackMs ?? null);
          // Circuit breaker check.
          const breakerDeadline = this.state.recordFailure(entry.provider);
          if (breakerDeadline !== null) {
            // Update cooling until to include breaker duration.
            this.state.markCooling(entry.provider, breakerDeadline - Date.now());
          }
          this.recordEvent({
            requestId,
            timestamp: Date.now(),
            outcome: "fallback",
            queuedAt: startedAt,
            provider: entry.provider,
            model: entry.model,
            errorMessage: err.message,
            ...context,
          });
          // Continue to next entry in fallback set.
          continue;
        }
        // Non-availability error — propagate. Record a single failed
        // event so the admin panel shows the upstream's reason rather
        // than the request vanishing mid-fallback.
        this.recordEvent({
          requestId,
          timestamp: Date.now(),
          outcome: "failed",
          queuedAt: startedAt,
          provider: entry.provider,
          model: entry.model,
          durationMs: Date.now() - startedAt,
          errorMessage: (err as Error).message,
          ...context,
        });
        throw err;
      } finally {
        release();
        this.pump();
      }
    }

    // If at least one provider was available but all failed, throw the
    // last error so the caller sees the actual upstream reason.
    if (anyAvailable && lastError) {
      this.recordEvent({
        requestId,
        timestamp: Date.now(),
        outcome: "failed",
        queuedAt: startedAt,
        errorMessage: lastError.message,
        durationMs: Date.now() - startedAt,
        ...context,
      });
      throw lastError;
    }

    // If no provider was available at all, queue the request.
    return this.enqueue(fallbackTargets, request, options, context, requestId, startedAt);
  }

  /** Queue a request until a provider slot frees up. */
  private enqueue(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options: CompleteOptions | undefined,
    context: QueueContext | undefined,
    requestId: string,
    queuedAt: number,
  ): Promise<ProviderResponse & { providerName: string }> {
    const priority: Priority = options?.priority ?? "interactive";
    this.recordEvent({
      requestId,
      timestamp: Date.now(),
      outcome: "queued",
      queuedAt,
      provider: fallbackTargets[0]?.provider,
      model: fallbackTargets[0]?.model,
      ...context,
    });
    return new Promise<ProviderResponse & { providerName: string }>((resolve, reject) => {
      const entry: QueuedEntry = {
        fallbackTargets,
        request,
        options,
        priority,
        queuedAt,
        signal: options?.signal,
        onAbort: undefined,
        aborted: false,
        resolve,
        reject,
        requestId,
        context,
      };

      const queue = priority === "interactive" ? this.interactiveQueue : this.backgroundQueue;
      for (const target of fallbackTargets) this.state.incrementQueued(target.provider);
      queue.push(entry);

      if (!options?.signal) return;
      const onAbort = (): void => {
        if (entry.aborted) return;
        entry.aborted = true;
        const i = queue.indexOf(entry);
        if (i !== -1) queue.splice(i, 1);
        for (const target of fallbackTargets) this.state.decrementQueued(target.provider);
        const reason = (options.signal as AbortSignal).reason;
        if (reason instanceof Error) reject(reason);
        else if (typeof reason === "string") reject(new Error(reason));
        else reject(new Error("aborted"));
      };
      entry.onAbort = onAbort;
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Called when a slot frees up. Iterates queued requests and dispatches
   * any whose fallback set now has an available provider. Processes
   * interactive queue first, then aged backgrounds. */
  pump(): void {
    this.drainInteractive();
    this.drainBackground();
  }

  private drainInteractive(): void {
    let i = 0;
    while (i < this.interactiveQueue.length) {
      const entry = this.interactiveQueue[i];
      if (entry.aborted) { this.interactiveQueue.splice(i, 1); continue; }

      const target = this.firstAvailable(entry.fallbackTargets);
      if (target) {
        this.interactiveQueue.splice(i, 1);
        for (const t of entry.fallbackTargets) this.state.decrementQueued(t.provider);
        this.dispatchQueued(target, entry);
        continue;
      }
      i++;
    }
  }

  private drainBackground(): void {
    let i = 0;
    while (i < this.backgroundQueue.length) {
      const entry = this.backgroundQueue[i];
      if (entry.aborted) { this.backgroundQueue.splice(i, 1); continue; }

      const target = this.firstAvailable(entry.fallbackTargets);
      if (target) {
        this.backgroundQueue.splice(i, 1);
        for (const t of entry.fallbackTargets) this.state.decrementQueued(t.provider);
        this.dispatchQueued(target, entry);
        continue;
      }

      const aged = entry.queuedAt + DEFAULT_AGED_MS <= Date.now();
      if (!aged && !target) break;
      i++;
    }
  }

  /** Find the first available target in a fallback set. */
  private firstAvailable(targets: FallbackTarget[]): FallbackTarget | null {
    for (const target of targets) {
      if (this.state.canAccept(target.provider)) return target;
    }
    return null;
  }

  /** Dispatch a queued entry to a specific fallback target. */
  private dispatchQueued(target: FallbackTarget, entry: QueuedEntry): void {
    const provider = this.providers[target.provider];
    if (!provider) {
      entry.reject(new Error(`Provider "${target.provider}" not found`));
      return;
    }
    this.executeWithRelease(provider, target.provider, entry.request, {
      ...entry.options,
      modelOverride: target.model,
    }, entry).then(entry.resolve, entry.reject);
  }

  /** Execute a request against a provider with slot management. */
  private async executeWithRelease(
    provider: Provider,
    name: string,
    request: AnthropicMessagesRequest,
    options: CompleteOptions | undefined,
    entry: QueuedEntry,
  ): Promise<ProviderResponse & { providerName: string }> {
    const release = this.state.acquire(name);
    this.recordEvent({
      requestId: entry.requestId,
      timestamp: Date.now(),
      outcome: "dispatched",
      queuedAt: entry.queuedAt,
      provider: name,
      model: options?.modelOverride,
      ...entry.context,
    });
    try {
      const response = await provider.complete(request, options);
      this.state.recordSuccess(name);
      this.recordEvent({
        requestId: entry.requestId,
        timestamp: Date.now(),
        outcome: "succeeded",
        queuedAt: entry.queuedAt,
        provider: name,
        model: options?.modelOverride,
        durationMs: Date.now() - entry.queuedAt,
        ...entry.context,
      });
      return { ...response, providerName: name };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        this.state.markCooling(name, err.retryAfterMs, this.state.get(name)?.cooldownFallbackMs ?? null);
        const breakerDeadline = this.state.recordFailure(name);
        if (breakerDeadline !== null) {
          this.state.markCooling(name, breakerDeadline - Date.now());
        }
        this.recordEvent({
          requestId: entry.requestId,
          timestamp: Date.now(),
          outcome: "fallback",
          queuedAt: entry.queuedAt,
          provider: name,
          model: options?.modelOverride,
          errorMessage: (err as Error).message,
          ...entry.context,
        });
        // Re-queue on the same fallback set so the queue can pick the
        // next available entry. Surface the upstream's last error to
        // whoever is awaiting the request. Pass the entry's existing
        // requestId through so every event for this logical request
        // shares one id — the admin panel can then group them by id
        // rather than by project+agent+fallbackSet heuristic.
        try {
          return await this.tryExecute(entry.fallbackTargets, entry.request, entry.options, entry.context, entry.requestId);
        } catch (finalErr) {
          this.recordEvent({
            requestId: entry.requestId,
            timestamp: Date.now(),
            outcome: "failed",
            queuedAt: entry.queuedAt,
            durationMs: Date.now() - entry.queuedAt,
            errorMessage: (finalErr as Error).message,
            ...entry.context,
          });
          throw finalErr;
        }
      }
      this.recordEvent({
        requestId: entry.requestId,
        timestamp: Date.now(),
        outcome: "failed",
        queuedAt: entry.queuedAt,
        durationMs: Date.now() - entry.queuedAt,
        errorMessage: (err as Error).message,
        ...entry.context,
      });
      throw err;
    } finally {
      release();
      this.pump();
    }
  }

  /** Abort all queued requests. Called on runtime reload. */
  abortAll(reason: string = "queue reset"): void {
    const err = new Error(reason);
    for (const queue of [this.interactiveQueue, this.backgroundQueue]) {
      for (const entry of queue) {
        entry.aborted = true;
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
        entry.reject(err);
      }
      queue.length = 0;
    }
  }

  /** Queue depth stats. */
  get queuedInteractive(): number { return this.interactiveQueue.length; }
  get queuedBackground(): number { return this.backgroundQueue.length; }
  get queuedTotal(): number { return this.interactiveQueue.length + this.backgroundQueue.length; }

  /** Generate a per-request id used to group activity events. Cheap
   *  monotonic counter + ms suffix; uniqueness within a process is
   *  sufficient for the admin log's purpose. */
  private freshRequestId(): string {
    this.requestCounter = (this.requestCounter + 1) & 0xffff;
    return `qr-${Date.now().toString(36)}-${this.requestCounter.toString(36)}`;
  }

  /** Record a single activity event. No-op when no log is wired in
   *  (always non-null in practice — the constructor guarantees an
   *  ActivityLog either owned or shared). */
  private recordEvent(input: Parameters<ActivityLog["record"]>[0]): void {
    this.activity?.record(input);
  }
}