import { ProviderUnavailableError, type AnthropicMessagesRequest, type TaskKind } from "../types.js";
import type { CompleteOptions, Priority, Provider, ProviderResponse } from "./types.js";
import type { GatewayConfig, ProviderEntry } from "../config.js";
import type { SpendTracker } from "./spend-tracker.js";

const DEFAULT_COOLDOWN_MS = 60_000;

/** Maps task kind to throttle priority. The interactive set covers the
 * paths where a user is mid-turn waiting: chat traffic (general), plus
 * the per-turn classifiers that gate routing before the chat gets a
 * reply. Memory curation is the only background kind today -- a chat
 * in progress shouldn't have to wait behind a curator's queued
 * request on a single-slot locally-hosted Ollama. The mapping is kept
 * in one place rather than threading the priority through every callsite
 * so a future task kind has to be deliberately classified. */
function priorityForTask(task: TaskKind): Priority {
  switch (task) {
    case "memoryCurator":
      return "background";
    case "general":
    case "permissionClassifier":
    case "complexityClassifier":
      return "interactive";
  }
}

export interface RoutedResponse extends ProviderResponse {
  /** Which named instance actually served this request -- may differ from
   * the top-priority entry if that one was on cooldown or over budget.
   * Callers that need to record cost against the right instance (see
   * spend-tracker.ts) read this off the response. */
  providerName: string;
}

/** Tracks per-provider cooldowns (e.g. after a rate-limit) so we skip a
 * provider until it's likely to have recovered, instead of retrying it on
 * every single request. */
class CooldownTracker {
  private readonly coolingUntil = new Map<string, number>();

  markUnavailable(provider: string, retryAfterMs?: number): void {
    this.coolingUntil.set(provider, Date.now() + (retryAfterMs ?? DEFAULT_COOLDOWN_MS));
  }

  isAvailable(provider: string): boolean {
    const until = this.coolingUntil.get(provider);
    return until === undefined || Date.now() >= until;
  }
}

/** Told about every provider-level availability change, so something
 * outside the router (the model registry the engineering manager reads) can
 * know a subscription window is exhausted instead of inferring it from
 * failed runs. */
export interface AvailabilityListener {
  onUnavailable(providerName: string, retryAfterMs: number, reason: string): void;
  onAvailable(providerName: string): void;
}

export class ProviderRouter {
  private readonly cooldowns = new CooldownTracker();
  private listener: AvailabilityListener | null = null;

  constructor(
    private readonly providers: Record<string, Provider>,
    private readonly config: GatewayConfig,
    private readonly spendTracker: SpendTracker,
  ) {}

  setAvailabilityListener(listener: AvailabilityListener): void {
    this.listener = listener;
  }

  /** Looks up a fixed task's configured priority list. The task-derived
   * throttle priority is the default; an explicit `options.priority` wins
   * (rare -- direct callers might want to send a synthetic request as
   * background without reverse-engineering the task kind). */
  async complete(task: TaskKind, request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<RoutedResponse> {
    const merged: CompleteOptions = { priority: priorityForTask(task), ...options };
    return this.completeWithEntries(this.config.tasks[task], request, merged, `task "${task}"`);
  }

  /** Runs the same priority/failover logic against an explicit entry list
   * instead of a fixed task -- used for complexity-tier routing, where the
   * entry list is picked dynamically per-turn rather than being one of the
   * fixed task kinds. */
  async completeWithEntries(
    entries: ProviderEntry[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
    label = "entries",
  ): Promise<RoutedResponse> {
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    let lastError: Error | undefined;
    // Why each candidate was passed over. Without this a skipped provider
    // produced "no provider is configured", which reads as a configuration
    // mistake when the real reason is usually a live cooldown or a spent
    // budget -- and sends you to check the wrong thing.
    const skipped: string[] = [];

    for (const entry of sorted) {
      const provider = this.providers[entry.provider];
      if (!provider) {
        skipped.push(`"${entry.provider}" is not a configured provider`);
        continue;
      }
      if (!this.cooldowns.isAvailable(provider.name)) {
        skipped.push(`"${entry.provider}" is cooling down after a rate limit or outage`);
        continue;
      }

      const budget = this.config.openaiCompatibleInstances[entry.provider]?.budget;
      if (!(await this.spendTracker.isWithinBudget(entry.provider, budget))) {
        skipped.push(`"${entry.provider}" has spent its configured budget for this period`);
        continue;
      }

      try {
        const response = await provider.complete(request, options);
        // A success is proof the window reopened, whatever we last recorded.
        this.listener?.onAvailable(provider.name);
        return { ...response, providerName: provider.name };
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          const retryAfterMs = err.retryAfterMs ?? DEFAULT_COOLDOWN_MS;
          this.cooldowns.markUnavailable(provider.name, err.retryAfterMs);
          // Anthropic's 429 carries its own 5-hour unified reset, so this is
          // the exact moment and duration a subscription window is known to
          // be exhausted -- the one signal worth telling the manager about.
          this.listener?.onUnavailable(provider.name, retryAfterMs, err.message);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    // Surface why, not just that. "No provider available" reads like a
    // misconfiguration and sends people to check their settings, when the
    // real cause is nearly always the last provider's own reason for
    // refusing -- an exhausted session window, a rate limit, a rejected key.
    if (lastError) throw lastError;
    if (skipped.length) throw new ProviderUnavailableError(`${label}: ${skipped.join("; ")}`);
    throw new ProviderUnavailableError(`${label}: no providers were offered for this request`);
  }
}
