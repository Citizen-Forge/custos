// Anthropic Messages -> OpenAI chat/completions request translation.
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
// shape on the way back out (see ./response.ts for the reverse direction).
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
// IMAGE PRESERVATION
// ------------------
// AnthropicMessagesRequest contents that include image blocks are
// translated to OpenAI chat/completions content arrays
// ({type:"text", text}|{type:"image_url", image_url:{url}}). A legacy
// string-only Anthropic style message continues to be emitted as a
// string for compatibility. Tool results can also carry inline image
// blocks; they preserve both text summaries and image_url parts.
import type { AnthropicContentBlock, AnthropicMessage, AnthropicMessagesRequest, VendorMetadata } from "../../types.js";
import type { OpenAIContentPart, OpenAIImagePart, OpenAIMessage, OpenAIRequest, OpenAIToolCall } from "./types.js";

export function blockText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as unknown as { text: string }).text)
    .join("\n");
}

/** Translate an Anthropic image block to an OpenAI `image_url` part.
 *  Anthropic shapes the source as `{type:"base64", media_type:"image/png", data}`
 *  for inline images and `{type:"url", url}` for remote ones; OpenAI takes a
 *  single `image_url.url` that's either a `data:` URI or an https URL.
 *  Inline base64 -> data URI; url -> url. Returns undefined for any image
 *  block we don't recognize so callers can fall back to a text summary
 *  instead of dropping the block. */
function anthropicImageBlockToPart(block: AnthropicContentBlock): OpenAIImagePart | undefined {
  const source = (block as { source?: unknown }).source as
    | { type?: string; media_type?: string; data?: string; url?: string }
    | undefined;
  if (!source || typeof source !== "object") return undefined;
  if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if ((source.type === "url" || source.type === undefined) && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return undefined;
}

/** Build an OpenAI content array from a list of Anthropic content blocks.
 *  Walks the blocks once and emits text + image parts in order; tool_use
 *  blocks are NOT included here (they go on `tool_calls` instead), and
 *  unknown block types drop out of the part list entirely rather than
 *  throwing -- the upstream either ignores them or rejects the request,
 *  which is the same behavior as the legacy string-only path. */
export function blocksToContentParts(blocks: AnthropicContentBlock[]): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const text = (b as unknown as { text: string }).text;
      if (typeof text === "string" && text.length > 0) parts.push({ type: "text", text });
      continue;
    }
    if (b.type === "image") {
      const img = anthropicImageBlockToPart(b);
      if (img) parts.push(img);
      continue;
    }
    // tool_use / tool_result / unknown -> dropped here (handled elsewhere)
  }
  return parts;
}

/** True when a content part is an `image_url` part (inline base64 or a
 *  remote URL). See ./fit-size.ts's `isInlineBase64ImagePart` for the
 *  narrower check used when deciding what to strip for size. */
export function isOpenAIImagePart(part: unknown): part is OpenAIImagePart {
  if (!part || typeof part !== "object") return false;
  const p = part as { type?: unknown; image_url?: { url?: unknown } };
  return p.type === "image_url" && typeof p.image_url?.url === "string";
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
 * The two helpers (`providerMetadataOf` above, `vendorMetadataOf`
 * here) are deliberately distinct despite the similar name. The
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
export function mergeMessageMetadata(current: VendorMetadata | undefined, incoming: VendorMetadata | undefined): VendorMetadata | undefined {
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
    // Images inside a tool_result are preserved as image_url parts so a
    // tool that returned a screenshot still flows through to the upstream
    // -- the fitRequestToSize helper decides whether to strip them per
    // the provider's maxRequestBytes limit.
    return toolResults.map((b) => {
      const block = b as unknown as { tool_use_id: string; content: string | AnthropicContentBlock[] };
      if (typeof block.content === "string") {
        return { role: "tool" as const, content: block.content, tool_call_id: block.tool_use_id };
      }
      const parts = blocksToContentParts(block.content);
      const content: string | OpenAIContentPart[] = parts.length > 0 ? parts : "";
      return { role: "tool" as const, content, tool_call_id: block.tool_use_id };
    });
  }

  const hasImages = msg.content.some((b) => b.type === "image");

  // Per-message extra_body is built from text block metadata, message
  // metadata, AND tool_use block metadata (last-wins per vendor). The
  // tool_use contribution is what makes older Gemini compatible: it only
  // reads the chain-of-thought signature from message-level extra_body,
  // so we need to fold the per-call metadata into this slot too.
  let extraBody: VendorMetadata | undefined = providerMetadataOf(msg);
  for (const b of msg.content) {
    if (b.type === "tool_use") continue; // folded below
    if (b.type === "tool_result") continue;
    if (b.type === "image") continue; // not a carrier
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
    // Even on tool_use turns, if the assistant message carried an image
    // block (rare -- usually vision happens on the user side), emit
    // content as an array so the image is preserved alongside the
    // tool_calls. Most turns skip this branch and fall through to
    // `text || null`.
    let content: string | null | OpenAIContentPart[];
    if (hasImages) {
      const parts = blocksToContentParts(msg.content);
      content = parts.length > 0 ? parts : null;
    } else {
      content = blockText(msg.content) || null;
    }
    const out: OpenAIMessage = {
      role: msg.role,
      content,
      tool_calls: openaiToolCalls,
    };
    if (extraBody) out.extra_body = extraBody;
    return [out];
  }

  // No tool_use in this turn. Images in the message become image_url
  // parts in an array; text-only messages keep the legacy string form
  // (paired with extra_body on the message slot for the carrier).
  const out: OpenAIMessage = { role: msg.role, content: "" };
  if (hasImages) {
    const parts = blocksToContentParts(msg.content);
    if (parts.length > 0) (out as { content: OpenAIContentPart[] }).content = parts;
  } else {
    out.content = blockText(msg.content) || null;
  }
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
