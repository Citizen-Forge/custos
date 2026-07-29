// Translates between the Anthropic Messages format (what this gateway speaks
// to Claude Code) and the OpenAI-compatible chat/completions format that
// Ollama, OpenAI, DeepSeek, Gemini (via its compat layer), OpenRouter, Mistral,
// Groq, xAI, Bedrock, etc. expose.
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
//
// IMAGE PRESERVATION
// ------------------
// AnthropicMessagesRequest contents that include image blocks are
// translated to OpenAI chat/completions content arrays
// ({type:"text", text}|{type:"image_url", image_url:{url}}). A legacy
// string-only Anthropic style message continues to be emitted as a
// string for compatibility. Tool results can also carry inline image
// blocks; they preserve both text summaries and image_url parts.
//
// Per-provider max-request-byte caps (see OpenAICompatibleInstanceConfig
// .maxRequestBytes) drop the oldest inline-base64 images from the
// request when the body would otherwise exceed the upstream's cap,
// so providers with smaller request-size limits (Groq: 32 MB,
// OpenRouter free-tier: per-model) keep working as conversations
// accumulate images.
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

/** OpenAI chat-completions content parts. Strings are still permitted
 *  as a shorthand for a single text part, but a message that contains
 *  any image is emitted as an array so the image_url part sits
 *  alongside the text in the same turn. Anthropic image blocks
 *  (base64- or URL-sourced) are translated to image_url; the rest of
 *  the content blocks (text, tool_use, tool_result) either fold
 *  into this array via their own paths or stay out of the content
 *  array entirely. */
export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: {
    /** `data:image/<media>;base64,<data>` for inline images, or an
     *  `http(s)://...` URL for remote ones. URL-only images don't need
     *  to be stripped by fitRequestToSize because the URL is small. */
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** String is shorthand for `[{type:"text", text: content}]`; null is
   * permitted for assistant turns that only carry tool_calls.
   * Image-bearing messages carry an array of text/image parts. */
  content: string | null | OpenAIContentPart[];
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
function blocksToContentParts(blocks: AnthropicContentBlock[]): OpenAIContentPart[] {
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

/** True when a content part is a base64 inline image (`data:image/...;base64,...`).
 *  These are the parts that contribute the most bytes to a serialized body,
 *  so the size-fitting helper strips exactly this kind and leaves URL-only
 *  image references untouched. */
export function isOpenAIImagePart(part: unknown): part is OpenAIImagePart {
  if (!part || typeof part !== "object") return false;
  const p = part as { type?: unknown; image_url?: { url?: unknown } };
  return p.type === "image_url" && typeof p.image_url?.url === "string";
}

function isInlineBase64ImagePart(part: OpenAIContentPart): boolean {
  return isOpenAIImagePart(part) && part.image_url.url.startsWith("data:");
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

/** Placeholder inserted when an image part is stripped from a message to
 *  fit the upstream's request size limit. Long enough that a reader
 *  scanning a multi-turn conversation can tell what happened, short
 *  enough that every replacement saves a real amount of bytes
 *  (compared to the kilobyte-or-larger base64 payload it replaces). */
const OMITTED_IMAGE_PLACEHOLDER: OpenAITextPart = {
  type: "text",
  text: "[previous image omitted — request size limit reached for this provider]",
};

/** Serialize an OpenAIRequest to a UTF-8 byte count. The size cap is
 *  measured against the wire byte count (not the character count) since
 *  that's what the upstream will see at its server. Buffer.byteLength
 *  measures UTF-8 byte length without allocating a string. */
function serializeRequestBytes(req: OpenAIRequest): number {
  // The shape is plain JSON (no Buffers/Maps/Sets), so a round-trip is
  // safe. Using Buffer.byteLength is the cheapest UTF-8 byte counter we
  // can write without pulling in a serialization library.
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}

/** Return the byte contribution of a single message's content parts to
 *  the overall request size, by serializing a one-message stand-in and
 *  subtracting the size of a stand-in without the part. Two
 *  serializations per candidate is still O(n) overall for `n` images
 *  rather than the O(n²) of stripping+re-measuring one-at-a-time, and
 *  gives a precise "how much will this strip save" number. */
function imagePartByteContribution(req: OpenAIRequest, msgIdx: number, partIdx: number): number {
  const candidate = req.messages[msgIdx]?.content;
  if (!Array.isArray(candidate)) return 0;
  const part = candidate[partIdx];
  if (!isInlineBase64ImagePart(part)) return 0;
  const before = serializeRequestBytes(req);
  const clone = JSON.parse(JSON.stringify(req)) as OpenAIRequest;
  const cloneCandidate = clone.messages[msgIdx].content as OpenAIContentPart[];
  cloneCandidate[partIdx] = OMITTED_IMAGE_PLACEHOLDER;
  const after = serializeRequestBytes(clone);
  return Math.max(0, before - after);
}

export interface FitRequestResult {
  request: OpenAIRequest;
  /** Number of image parts replaced with the placeholder text. Zero
   *  when the request fit unchanged; positive when the strip path ran.
   *  Operators see this in the activity log per dispatch. */
  stripped: number;
  /** Number of complete conversation turns removed from the request
   *  to fit the size limit. Zero when text truncation wasn't needed;
   *  positive when the fit path dropped older messages. Distinct from
   *  `stripped` which only counts image replacements — both can be
   *  non-zero when the conversation has images AND text that push the
   *  body over the limit. */
  truncatedMessages: number;
  /** True when the strip path ran but the body is still over
   *  `maxBytes` because nothing was strippable (no images left, or all
   *  remaining images are URL-only and already small). Caller should
   *  fail the request with a clear "request too large" error rather
   *  than silently sending an over-limit body the upstream will reject. */
  stillOverLimit: boolean;
  /** Initial serialized size in bytes, before any stripping. Useful
   *  for diagnostics when an over-limit error surfaces to the admin
   *  panel. */
  initialBytes: number;
  /** Final serialized size in bytes, after all strips. */
  finalBytes: number;
}

/** Walk an OpenAIRequest and replace inline-base64 image parts with
 *  text placeholders, oldest first, until the body fits `maxBytes`.
 *
 * Algorithm:
 *  1. Clone the request so the caller's reference is untouched.
 *  2. Compute initial size. If already under `maxBytes`, return
 *     unchanged (no strip).
 *  3. Build a list of all eligible strip targets (one per inline
 *     base64 image_url part, in oldest-first walk order = messages[N]
 *     then parts[N]).
 *  4. For each target, measure its byte contribution by
 *     simulating a single replacement off the original, then size
 *     delta. Summing cumulative cuts oldest-first lets us decide the
 *     minimum number of strips in O(n) work, then one final
 *     `serializeRequestBytes` confirms size.
 *  5. If the cumulative cut reaches `initialBytes - maxBytes`,
 *     strip those targets and return; if even with all targets
 *     stripped we can't fit, return `stillOverLimit: true`.
 *
 * Only `data:`-prefixed image_url parts are eligible. URL-only image
 * references stay (their URL string is the byte cost and is already
 * small). Both message content and tool-result content are walked
 * because `anthropicMessageToOpenAI` emits content arrays there too. */
export function fitRequestToSize(req: OpenAIRequest, maxBytes: number): FitRequestResult {
  const initialBytes = serializeRequestBytes(req);
  if (initialBytes <= maxBytes) {
    return { request: req, stripped: 0, truncatedMessages: 0, stillOverLimit: false, initialBytes, finalBytes: initialBytes };
  }

  // Collect every strippable (msgIdx, partIdx) in oldest-first order.
  // The order matters because we want to drop the OLDEST images first
  // (most recent turns are usually more relevant to the current
  // conversation context). The upstream error message literally says
  // "Remove older images or compact the conversation" -- matching
  // that heuristic is the whole point.
  const targets: Array<{ msgIdx: number; partIdx: number }> = [];
  for (let m = 0; m < req.messages.length; m++) {
    const content = req.messages[m].content;
    if (typeof content === "string" || content === null) continue;
    for (let p = 0; p < content.length; p++) {
      if (isInlineBase64ImagePart(content[p])) targets.push({ msgIdx: m, partIdx: p });
    }
  }

  // No inline-base64 images to strip. Fall through to text truncation:
  // remove the oldest complete turns (everything after the system prompt
  // and before the most recent user message) until the body fits. This
  // matches the heuristic the Groq error suggests ("compact the conversation")
  // and lets long-running agent conversations keep making progress even
  // when the accumulated text of tool results and code blocks exceeds the
  // provider's request-size cap.
  if (targets.length === 0) {
    const truncated = truncateOldestMessages(req, initialBytes, maxBytes);
    if (truncated) return truncated;
    return { request: req, stripped: 0, truncatedMessages: 0, stillOverLimit: true, initialBytes, finalBytes: initialBytes };
  }

  // Walk targets oldest-first, accumulating byte savings. As soon as
  // cumulative savings >= initialBytes - maxBytes, we know the
  // remaining candidates can be left intact. This is O(n) where n is
  // the number of strippable images -- per-strip measurements would be
  // O(n²).
  const cloned: OpenAIRequest = JSON.parse(JSON.stringify(req));
  const neededCuts = initialBytes - maxBytes;
  let cumulativeCuts = 0;
  let stripped = 0;
  for (const t of targets) {
    const contribution = imagePartByteContribution(req, t.msgIdx, t.partIdx);
    const targetParts = cloned.messages[t.msgIdx].content as OpenAIContentPart[];
    targetParts[t.partIdx] = OMITTED_IMAGE_PLACEHOLDER;
    stripped++;
    cumulativeCuts += contribution;
    if (cumulativeCuts >= neededCuts) break;
  }

  const finalBytes = serializeRequestBytes(cloned);
  if (finalBytes <= maxBytes) {
    return {
      request: cloned,
      stripped,
      truncatedMessages: 0,
      stillOverLimit: false,
      initialBytes,
      finalBytes,
    };
  }

  // Stripped all images but still over the limit. Try text truncation
  // as a last resort — remove oldest turns until the body fits.
  const truncated = truncateOldestMessages(cloned, finalBytes, maxBytes);
  if (truncated) return { ...truncated, stripped };

  return {
    request: cloned,
    stripped,
    truncatedMessages: 0,
    stillOverLimit: true,
    initialBytes,
    finalBytes,
  };
}

/** Remove the oldest complete turns (everything after the system prompt
 *  and before the most recent user message) from an OpenAI request until
 *  its serialized body fits `maxBytes`. Returns a FitRequestResult when
 *  truncation succeeds (stillOverLimit can still be true if even the
 *  most recent turn alone exceeds the limit), or undefined when the
 *  request has no messages to trim (only system + one user message).
 *  The system prompt at index 0 is always preserved. */
function truncateOldestMessages(req: OpenAIRequest, currentBytes: number, maxBytes: number): FitRequestResult | undefined {
  // Need at least system (0) + one user message to have anything to trim.
  // If we only have 2 messages (system + user), there's nothing old to drop.
  if (req.messages.length < 3) return undefined;

  // Find the last user message — this is the current turn. Keep it
  // and everything after it (assistant response, tool results).
  let lastUserIdx = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 1) return undefined;  // nothing between system and this user

  const removedCount = lastUserIdx - 1;
  const clone: OpenAIRequest = JSON.parse(JSON.stringify(req));
  // Remove messages from index 1 up to (but not including) lastUserIdx.
  // Index 0 is the system prompt, which we keep.
  clone.messages.splice(1, removedCount);

  const finalBytes = serializeRequestBytes(clone);
  return {
    request: clone,
    stripped: 0,
    truncatedMessages: removedCount,
    stillOverLimit: finalBytes > maxBytes,
    initialBytes: currentBytes,
    finalBytes,
  };
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
   * (it's the more specific placement); root-level fields that don't
   * conflict with anything still get carried through. */
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
