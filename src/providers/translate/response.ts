// OpenAI chat/completions response -> Anthropic Messages response
// translation. See ./request.ts's header comment for the vendor-carrier
// strategy this mirrors on the way back in.
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
//   Streaming (`translateStream`, in ../openai-compatible.ts) does NOT
//   currently extend to the response_root path. The exact streaming
//   placement is left unspecified here -- verify against upstream docs
//   before wiring up. Streaming extension is deferred until a vendor
//   actually requires it; the limitation is documented here so a future
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
import type { AnthropicContentBlock, AnthropicMessagesResponse } from "../../types.js";
import { mergeMessageMetadata, vendorMetadataOf } from "./request.js";
import type { OpenAIResponse } from "./types.js";

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
