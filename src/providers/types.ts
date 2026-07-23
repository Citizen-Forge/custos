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
}

export interface Provider {
  readonly name: string;
  complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse>;
}
