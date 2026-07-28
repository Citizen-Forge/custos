// Minimal subset of the Anthropic Messages API surface this gateway needs to
// understand. Fields we don't inspect are passed through untyped via
// index signatures so we never drop data we don't recognize.

/** Loose vendor-metadata carrier. Keys are typically vendor
 * namespaces (`google`, `openrouter`, `bedrock`) but may also be
 * upstream-emitted field names when an upstream places vendor state
 * at the response root (e.g. OpenRouter's `provider_specific_fields`
 * is captured directly onto the carrier without an `openrouter`
 * wrapper so the upstream's natural shape round-trips). The type
 * stays opaque so callers don't depend on shape -- the translator
 * (see providers/openai-translate.ts) threads whatever the upstream
 * emits through to the next turn. */
export type VendorMetadata = { [vendor: string]: unknown };

/** Late-arrival vendor metadata delta emitted inline on the
 * Anthropic-content_block_delta stream only when the
 * `emitLateMetadataDelta` flag is set on the upstream instance config.
 *
 * The flag is OFF by default because (a) the Anthropic SSE spec does
 * not reserve `vendor_metadata_delta` so strict SDK parsers will
 * surface an "unknown event" warning, and (b) the only client known
 * to honor it is a future first-party client that subscribes to
 * vendor metadata and merges it onto the still-open content_block.
 * Turn the flag ON only when the downstream client is one such
 * custom consumer. */
export interface VendorMetadataDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "vendor_metadata_delta";
    provider_metadata: VendorMetadata;
  };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
  /** Vendor-specific per-message metadata. Survives the round-trip so
   * per-message state from upstream (Bedrock trace IDs, Gemini
   * chain-of-thought carrier, OpenRouter provider_specific_fields) is
   * carried across turns. Loose on purpose -- adding a new upstream
   * vendor is a no-op for the translator. */
  provider_metadata?: VendorMetadata;
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
export type TaskKind = "general" | "permissionClassifier" | "memoryCurator" | "complexityClassifier";

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
