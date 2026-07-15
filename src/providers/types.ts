import type { AnthropicMessagesRequest } from "../types.js";

export interface ProviderResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface Provider {
  readonly name: string;
  complete(request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<ProviderResponse>;
}
