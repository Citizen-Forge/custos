// Translates between the Anthropic Messages format (what this gateway speaks
// to Claude Code) and the OpenAI-compatible chat/completions format that
// Ollama, OpenAI, Gemini (via its compat layer), OpenRouter, Mistral, Groq,
// DeepSeek, Bedrock, etc. expose.
//
// VENDOR CARRIER STRATEGY
// -----------------------
// Each OpenAI-compat upstream tacks private state onto a chat/completions
// turn that the client must round-trip back on the next turn or the
// conversation goes off the rails:
//   - Gemini thinking models: `extra_body/google/thought_signature` and
//     `tool_calls[j].extra_content.google.thought_signature`.
//   - OpenRouter: `provider_specific_fields` and per-tool vendor blobs.
//   - Bedrock: trace ids and performanceConfig.
//   - Future vendors: TBD / whatever shape they pick.
//
// We don't *care* about the shape inside. We treat vendor state as opaque
// in-transit data and carry it through the Anthropic side as
// `provider_metadata[vendor]` on tool_use / text blocks. The carrier is
// typed `{ [vendor: string]: unknown }` so adding a new upstream is a
// no-op for the translator -- Claude Code is responsible for round-
// tripping the blocks verbatim, then the carrier restores the same
// shape on the way back out.
//
// ON THE WAY OUT (Anthropic -> OpenAI):
//   * provider_metadata on each tool_use block is forwarded to
//     messages[i].tool_calls[j].extra_content. Per-call slot.
//   * provider_metadata on text blocks AND on the assistant message AND
//     on tool_use blocks is merged (last-wins per vendor) into
//     messages[i].extra_body. Per-message slot.
//
// The "tool_use merges into extra_body" rule preserves Gemini's older
// behavior, where the chain-of-thought signature was only emitted on the
// message slot; newer Gemini also sees it via per-call extra_content.
// Other vendors that put per-call state in extra_content will see their
// own blocks' metadata correctly via that route.
//
// ON THE WAY IN (OpenAI -> Anthropic):
//   * `choices[0].message.extra_content` is per-message (Gemini-style
//     compat layers).
//   * Response-root `provider_specific_fields` is OpenRouter's canonical
//     placement and may also be used by other vendors in the future.
//   Both fold into the same per-message carrier with last-wins merge:
//   message-level overrides on per-vendor conflict (it's the more
//   specific placement). The response-root fields are surfaced
//   verbatim on the carrier so an OpenRouter->Gemini reroute carries
//   the reasoning hint across turn boundaries.
//
//   Streaming (`translateStream`) does NOT currently extend to the
//   response_root path. The exact streaming placement is left
//   unspecified here -- verify against upstream docs before wiring
//   up. Streaming extension is deferred until a vendor actually
//   requires it; the limitation is documented here so a future
//   reader treats it as deliberate rather than a missed code path.
//
// LIMITS
// ------
// Anthropic's SSE has no metadata slot on `content_block_delta`, so any
// vendor field that arrives *after* `content_block_start` has fired is
// dropped on the streaming side. This is a documented limitation, not a
// synthetic event the client would have to learn about. (Streaming fix
// requires buffering deltas until a stable point -- deferred until a
// vendor actually requires it.)
//
// Some strict OpenAI Chat-Completions clients reject unknown fields on
// tool_calls with a 400. Conversations that originated on a permissive
// upstream and then get rerouted to a strict one will fail. The router
// pins models to providers via `custos:<providerKey>/<model>` (see
// model-alias.ts) -- engineering workflows that chose a thinking model
// should pin it.
//
// The translator only emits `extra_body` / `extra_content` when there is
// actually a vendor payload to carry; clean non-vendor conversations
// never see these fields, so strict clients only run into the issue if
// a vendor turn was completed earlier in the same conversation.
import type { AnthropicContentBlock, AnthropicMessage, AnthropicMessagesRequest, AnthropicMessagesResponse, VendorMetadata } from "../types.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Vendor-specific per-tool-call metadata. Newer Gemini reads
   * `extra_content.google.thought_signature` here; other vendors put
   * their per-call state in this slot too. */
  extra_content?: VendorMetadata;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** Vendor-specific per-message metadata. Older Gemini reads
   * `extra_body.google.thought_signature` here; other vendors use this
   * per-message slot for their state too. */
  extra_body?: VendorMetadata;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[];
}

export function blockText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as unknown as { text: string }).text)
    .join("\n");
}

/**
 * Read the carrier off an Anthropic content block or assistant message.
 * The input is expected to have a `provider_metadata` field; if not, the
 * call site is wrong and the helper returns undefined (rather than
 * returning the container itself, which would silently leak
 * `role` / `content` / `type` keys into the outgoing extra_body).
 */
export function providerMetadataOf(target: unknown): VendorMetadata | undefined {
  if (!target || typeof target !== "object") return undefined;
  const meta = (target as { provider_metadata?: unknown }).provider_metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const obj = meta as Record<string, unknown>;
  return Object.keys(obj).length > 0 ? (obj as VendorMetadata) : undefined;
}

/**
 * Coerce a raw vendor payload -- the JSON-parsed `extra_content` from an
 * OpenAI-compat response, or the equivalent on a stream chunk -- into
 * the carrier shape. Returns undefined for missing, non-object, array,
 * or empty payloads.
 *
 * The two helpers (`providerMetadataOf` here, `vendorMetadataOf`
 * below) are deliberately distinct despite the similar name. The
 * previous version combined them into a single polymorphic helper that
 * looked polished but had a structural bug: an AnthropicMessage without
 * `provider_metadata` is itself a valid non-empty record, so the
 * polymorphic helper would mistakenly return the message as the
 * carrier, polluting the outgoing `extra_body` with `role` and
 * `content`. Two named helpers force the caller to pick the right shape
 * for the right direction.
 */
export function vendorMetadataOf(payload: unknown): VendorMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  return Object.keys(obj).length > 0 ? (obj as VendorMetadata) : undefined;
}

/** Merge a block's provider_metadata into the per-message extra_body,
 * last-wins per vendor namespace. Returns the merged object (a new
 * reference) or undefined if both inputs are empty. */
function mergeMessageMetadata(current: VendorMetadata | undefined, incoming: VendorMetadata | undefined): VendorMetadata | undefined {
  if (!incoming) return current;
  if (!current) return { ...incoming };
  return { ...current, ...incoming };
}

function anthropicMessageToOpenAI(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const toolResults = msg.content.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    // Anthropic represents tool results as user-role content blocks; OpenAI
    // wants a distinct "tool" message per result, keyed by tool_call_id.
    return toolResults.map((b) => {
      const block = b as unknown as { tool_use_id: string; content: string | AnthropicContentBlock[] };
      return {
        role: "tool" as const,
        content: typeof block.content === "string" ? block.content : blockText(block.content),
        tool_call_id: block.tool_use_id,
      };
    });
  }

  const text = blockText(msg.content);

  // Per-message extra_body is built from text block metadata, message
  // metadata, AND tool_use block metadata (last-wins per vendor). The
  // tool_use contribution is what makes older Gemini compatible: it only
  // reads the chain-of-thought signature from message-level extra_body,
  // so we need to fold the per-call metadata into this slot too.
  let extraBody: VendorMetadata | undefined = providerMetadataOf(msg);
  for (const b of msg.content) {
    if (b.type === "tool_use") continue; // folded below
    if (b.type === "tool_result") continue;
    extraBody = mergeMessageMetadata(extraBody, providerMetadataOf(b));
  }

  const openaiToolCalls: OpenAIToolCall[] = [];
  for (const b of msg.content) {
    if (b.type !== "tool_use") continue;
    const block = b as unknown as { id: string; name: string; input: unknown };
    const blockMeta = providerMetadataOf(b);
    const call: OpenAIToolCall = {
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    };
    if (blockMeta) call.extra_content = blockMeta;
    openaiToolCalls.push(call);
    // Fold into message-level extra_body too -- last tool_use wins per
    // vendor. The per-call extra_content above is the explicit per-call
    // slot; the extra_body fold keeps older Gemini compatible.
    extraBody = mergeMessageMetadata(extraBody, blockMeta);
  }

  if (openaiToolCalls.length > 0) {
    const out: OpenAIMessage = {
      role: msg.role,
      content: text || null,
      tool_calls: openaiToolCalls,
    };
    if (extraBody) out.extra_body = extraBody;
    return [out];
  }

  // No tool_use in this turn. Vendor state lives on text blocks (e.g.
  // thought-only Gemini turns, Bedrock trace summaries, OpenRouter
  // provider_specific_fields surfaced as assistant text) and goes onto
  // the message-level extra_body.
  const out: OpenAIMessage = { role: msg.role, content: text };
  if (extraBody) out.extra_body = extraBody;
  return [out];
}

export function toOpenAIRequest(req: AnthropicMessagesRequest, model: string): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (req.system) {
    messages.push({ role: "system", content: typeof req.system === "string" ? req.system : blockText(req.system) });
  }
  for (const msg of req.messages) {
    messages.push(...anthropicMessageToOpenAI(msg));
  }

  const out: OpenAIRequest = {
    model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
  };

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = (req.tools as { name: string; description?: string; input_schema: unknown }[]).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  return out;
}

interface OpenAIResponseChoiceMessage {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Vendor-specific per-message metadata on the response side. Gemini
   * reads `extra_content.google.thought_signature` here. Other vendors
   * place per-message state here too. */
  extra_content?: VendorMetadata;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: {
    message: OpenAIResponseChoiceMessage;
    finish_reason: string;
  }[];
  /** Vendor-specific response-root metadata. OpenRouter emits
   * `provider_specific_fields` here at the response root, not on
   * `choices[0].message.extra_content`. Other vendors may follow the
   * same convention. Folded into the per-message carrier with
   * last-wins merge: message-level overrides on per-vendor conflict
   * (it's the more specific placement). */
  provider_specific_fields?: VendorMetadata;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function mapFinishReason(reason: string): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

export function fromOpenAIResponse(res: OpenAIResponse, requestedModel: string): AnthropicMessagesResponse {
  const choice = res.choices[0];
  const content: AnthropicContentBlock[] = [];

  // Read per-message vendor metadata from the response side. Two
  // admissible placements:
  //   1. `choices[0].message.extra_content` -- per-message slot used by
  //      Gemini and most Gemini-style compat layers.
  //   2. response-root `provider_specific_fields` -- OpenRouter's
  //      canonical placement; some other vendors may follow the same
  //      convention.
  // Both fold into the same per-message carrier. The merge is
  // last-wins with the message-level slot taking precedence on
  // per-vendor conflict (it's the more specific placement); root-level
  // fields that don't conflict with anything still get carried
  // through.
  let messageMeta = vendorMetadataOf(choice.message.extra_content);
  const rootMeta = vendorMetadataOf(res.provider_specific_fields);
  messageMeta = mergeMessageMetadata(rootMeta, messageMeta);

  if (choice.message.content) {
    // With no tool calls, the only Anthropic content Claude Code will
    // round-trip verbatim across turns is a text block -- so that's
    // where the message-level vendor metadata lives. With tool calls
    // present, the per-tool-call metadata in the loop below takes over.
    const textBlock: AnthropicContentBlock = { type: "text", text: choice.message.content };
    if (messageMeta) textBlock.provider_metadata = messageMeta;
    content.push(textBlock);
  }

  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    const block: AnthropicContentBlock = { type: "tool_use", id: call.id, name: call.function.name, input };
    // Per-tool-call metadata wins (newer Gemini's preferred placement);
    // fall back to the message-level metadata so an upstream that emits
    // vendor state only once per turn still round-trips cleanly.
    const callMeta = vendorMetadataOf(call.extra_content);
    const finalMeta = callMeta ?? messageMeta;
    if (finalMeta) block.provider_metadata = finalMeta;
    content.push(block);
  }

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
