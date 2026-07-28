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
 */

import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import type { Provider, CompleteOptions, ProviderResponse, Priority } from "./types.js";
import { ProviderStateMap } from "./provider-state.js";

const DEFAULT_AGED_MS = 5_000;

export interface FallbackTarget {
  /** Provider name (key in the providers map). */
  provider: string;
  /** Model to use when dispatching to this provider. Passed as
   * modelOverride in CompleteOptions so the provider uses this model
   * instead of its default. */
  model: string;
}

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
}

export class GlobalQueue {
  private readonly interactiveQueue: QueuedEntry[] = [];
  private readonly backgroundQueue: QueuedEntry[] = [];
  private providers: Record<string, Provider>;
  private state: ProviderStateMap;

  constructor(providers: Record<string, Provider>, state: ProviderStateMap) {
    this.providers = providers;
    this.state = state;
  }

  /** Replace providers map on config reload. */
  setProviders(providers: Record<string, Provider>): void {
    this.providers = providers;
  }

  /** Replace state map reference on config reload. */
  setStateMap(state: ProviderStateMap): void {
    this.state = state;
  }

  /** Submit a request with a fallback set of { provider, model } pairs.
   * Tries each entry in order; on ProviderUnavailableError falls through
   * to the next. Queues when no provider is available right now. The
   * model from each entry is passed as modelOverride in the options so
   * the provider uses the fallback set's chosen model. */
  async complete(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
  ): Promise<ProviderResponse & { providerName: string }> {
    return this.tryExecute(fallbackTargets, request, options);
  }

  /** Try to execute against each entry in the fallback set in order.
   * If a provider throws ProviderUnavailableError, the cooldown is
   * recorded and the next entry is tried. If ALL providers fail,
   * the last error is thrown. If no provider is even checkable (all
   * at capacity/cooldown), the request is queued. The entry's model
   * is passed as modelOverride so the provider uses the fallback set's
   * chosen model rather than its default. */
  private async tryExecute(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
  ): Promise<ProviderResponse & { providerName: string }> {
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
      try {
        const response = await provider.complete(request, mergedOptions);
        this.state.recordSuccess(entry.provider);
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
          // Continue to next entry in fallback set.
          continue;
        }
        throw err; // Non-availability error — propagate.
      } finally {
        release();
        this.pump();
      }
    }

    // If at least one provider was available but all failed, throw the
    // last error so the caller sees the actual upstream reason.
    if (anyAvailable && lastError) throw lastError;

    // If no provider was available at all, queue the request.
    return this.enqueue(fallbackTargets, request, options);
  }

  /** Queue a request until a provider slot frees up. */
  private enqueue(
    fallbackTargets: FallbackTarget[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
  ): Promise<ProviderResponse & { providerName: string }> {
    const priority: Priority = options?.priority ?? "interactive";
    return new Promise<ProviderResponse & { providerName: string }>((resolve, reject) => {
      const entry: QueuedEntry = {
        fallbackTargets,
        request,
        options,
        priority,
        queuedAt: Date.now(),
        signal: options?.signal,
        onAbort: undefined,
        aborted: false,
        resolve,
        reject,
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
    }).then(entry.resolve, entry.reject);
  }

  /** Execute a request against a provider with slot management. */
  private async executeWithRelease(
    provider: Provider,
    name: string,
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
  ): Promise<ProviderResponse & { providerName: string }> {
    const release = this.state.acquire(name);
    try {
      const response = await provider.complete(request, options);
      this.state.recordSuccess(name);
      return { ...response, providerName: name };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        this.state.markCooling(name, err.retryAfterMs, this.state.get(name)?.cooldownFallbackMs ?? null);
        const breakerDeadline = this.state.recordFailure(name);
        if (breakerDeadline !== null) {
          this.state.markCooling(name, breakerDeadline - Date.now());
        }
      }
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
}
