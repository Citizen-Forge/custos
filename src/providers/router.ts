import { ProviderUnavailableError, type AnthropicMessagesRequest, type TaskKind } from "../types.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { GatewayConfig, ProviderEntry } from "../config.js";
import type { SpendTracker } from "./spend-tracker.js";

const DEFAULT_COOLDOWN_MS = 60_000;

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

export class ProviderRouter {
  private readonly cooldowns = new CooldownTracker();

  constructor(
    private readonly providers: Record<string, Provider>,
    private readonly config: GatewayConfig,
    private readonly spendTracker: SpendTracker,
  ) {}

  /** Looks up a fixed task's configured priority list. */
  async complete(task: TaskKind, request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<RoutedResponse> {
    return this.completeWithEntries(this.config.tasks[task], request, signal, `task "${task}"`);
  }

  /** Runs the same priority/failover logic against an explicit entry list
   * instead of a fixed task -- used for complexity-tier routing, where the
   * entry list is picked dynamically per-turn rather than being one of the
   * fixed task kinds. */
  async completeWithEntries(
    entries: ProviderEntry[],
    request: AnthropicMessagesRequest,
    signal?: AbortSignal,
    label = "entries",
  ): Promise<RoutedResponse> {
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    let lastError: Error | undefined;

    for (const entry of sorted) {
      const provider = this.providers[entry.provider];
      if (!provider) continue;
      if (!this.cooldowns.isAvailable(provider.name)) continue;

      const budget = this.config.openaiCompatibleInstances[entry.provider]?.budget;
      if (!(await this.spendTracker.isWithinBudget(entry.provider, budget))) continue;

      try {
        const response = await provider.complete(request, signal);
        return { ...response, providerName: provider.name };
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          this.cooldowns.markUnavailable(provider.name, err.retryAfterMs);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new ProviderUnavailableError(`no provider configured/available for ${label}`);
  }
}
