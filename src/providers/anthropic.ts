import { getValidAccessToken } from "../auth/credentials.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import type { Provider, ProviderResponse } from "./types.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Beta flags Claude Code itself sends on OAuth-authenticated requests.
const OAUTH_BETA_HEADER = "oauth-2025-04-20,claude-code-20250219";

export interface AnthropicProviderConfig {
  /** Static API key used when OAuth is unavailable or rejected. */
  apiKey?: string;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(private readonly config: AnthropicProviderConfig) {}

  async complete(request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const accessToken = await getValidAccessToken().catch(() => null);

    if (accessToken) {
      const res = await this.send(request, { authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA_HEADER }, signal);
      if (res.status !== 401 && res.status !== 403) return this.classify(res);
      if (!this.config.apiKey) return this.classify(res);
      // OAuth rejected -- fall through to API key if we have one.
    }

    if (this.config.apiKey) {
      const res = await this.send(request, { "x-api-key": this.config.apiKey }, signal);
      return this.classify(res);
    }

    throw new ProviderUnavailableError("anthropic: no OAuth session and no API key configured");
  }

  private send(request: AnthropicMessagesRequest, authHeaders: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return fetch(MESSAGES_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...authHeaders,
      },
      body: JSON.stringify(request),
    });
  }

  /** Turn rate-limit / usage-limit responses into a failover signal for the router. */
  private classify(res: Response): ProviderResponse {
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      throw new ProviderUnavailableError("anthropic: rate limited", retryAfterMs);
    }
    return { status: res.status, headers: res.headers, body: res.body };
  }
}
