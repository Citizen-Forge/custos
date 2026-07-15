import { ProviderUnavailableError, type AnthropicMessagesRequest, type TaskKind } from "../types.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { GatewayConfig } from "../config.js";

const DEFAULT_COOLDOWN_MS = 60_000;

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
  ) {}

  async complete(task: TaskKind, request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const entries = [...this.config.tasks[task]].sort((a, b) => a.priority - b.priority);
    let lastError: Error | undefined;

    for (const entry of entries) {
      const provider = this.providers[entry.provider];
      if (!provider) continue;
      if (!this.cooldowns.isAvailable(provider.name)) continue;

      try {
        return await provider.complete(request, signal);
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          this.cooldowns.markUnavailable(provider.name, err.retryAfterMs);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new ProviderUnavailableError(`no provider configured/available for task "${task}"`);
  }
}
