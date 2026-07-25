import type { AnthropicMessagesRequest } from "../types.js";

export interface ProviderResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** The `anthropic-beta` header the *client* sent, forwarded verbatim.
   * Claude Code gates newer request-body fields (e.g. context_management)
   * behind beta flags it declares here; Custos must pass them through or
   * Anthropic rejects the body as containing unpermitted extra inputs.
   * Only the Anthropic provider uses this -- OpenAI-compatible providers
   * ignore it. */
  clientBetaHeader?: string;
  /** Real model name for a request that arrived under a pinned
   * `custos:<provider>/<model>` alias. OpenAI-compatible instances
   * otherwise always send their own configured model and would ignore the
   * caller's choice, which defeats the point of pinning -- an engineering
   * manager that picked a specific model has to actually get it. Unset for
   * normally-routed requests, where the instance's configured model wins. */
  modelOverride?: string;
}

export interface Provider {
  readonly name: string;
  complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse>;
}
