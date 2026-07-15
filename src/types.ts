// Minimal subset of the Anthropic Messages API surface this gateway needs to
// understand. Fields we don't inspect are passed through untyped via
// index signatures so we never drop data we don't recognize.

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock = { type: string; [key: string]: unknown };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

/** Task categories the router assigns provider priority lists to. */
export type TaskKind = "general" | "permissionClassifier" | "memoryCurator";

/** Raised by a provider when the request should fail over to the next priority. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
