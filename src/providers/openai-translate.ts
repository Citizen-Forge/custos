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
import { extractContentText } from "../memory/curator.js";

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
};/** Serialize an OpenAIRequest to a UTF-8 byte count. The size cap is
 * measured against the wire byte count (not the character count) since
 * that's what the upstream will see at its server. Buffer.byteLength
 * measures UTF-8 byte length without allocating a string. */
export function serializeRequestBytes(req: OpenAIRequest): number {
  // The shape is plain JSON (no Buffers/Maps/Sets), so a round-trip is
  // safe. Using Buffer.byteLength is the cheapest UTF-8 byte counter we
  // can write without pulling in a serialization library.
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}

/**
 * Mirrors the curator's compact-pass byte estimator (see `runCompactPass`
 * in `src/memory/curator.ts`) but operates on a live `OpenAIRequest`
 * rather than stored session-file lines. Returns the bytes the curator
 * WOULD report if it ever got to see this conversation -- useful for
 * comparing "what was actually dispatched" vs "what the curator thinks
 * the same dispatch weighs", which exposes both the curator's
 * per-line underestimation (each session-file line stores only the
 * current turn's user prompt, when the live cumulative dispatch carries
 * every prior turn's user/assistant/tool messages) and the gap where
 * failing requests never get persisted at all.
 *
 * Numbers pinched from curator.ts to keep both sides in lockstep:
 *   - `30` bytes for the FIRST system message envelope,
 *   - `28` bytes per user message envelope,
 *   - one-time `15` bytes for the OpenAI `{"messages":[…]}` wrapper
 *     plus `messageCount - 1` bytes for inter-message commas,
 *   - tools and system message text counted ONCE per request (the
 *     session-file format repeats these on every line; the recent
 *     `staticToolsBytes` / `staticSystemBytes` accumulator
 *     de-duplicates them). Reuses `extractContentText` from
 *     `curator.ts` so this mirror can't drift from the curator's
 *     actual algorithm on tool_result recursion (the most common
 *     agent-conversation content shape).
 */
export function estimateCompactPassBytes(req: OpenAIRequest): number {
  let bytes = 0;
  let messageCount = 0;
  let toolsBytes = 0;
  if (req.tools && req.tools.length > 0) {
    toolsBytes = Buffer.byteLength(JSON.stringify(req.tools), "utf8");
  }
  // Mirror curator's per-line accumulation: a session-file line stores
  // only the CURRENT turn's user prompt in `request.messages`, so the
  // curator counts `+28 + text` for the one user message per line
  // (plus `+30 + text` for system ONLY when `messageCount === 0`,
  // which fires once per session at most) and never counts assistant
  // or tool messages because they are not present in any session-file
  // line's `request.messages`. For a live cumulative request the
  // analog is system at index 0 + every user message after, with the
  // same assistant/tool skip — anything the curator never sees
  // contributes a gap the diagnostic log will surface.
  for (const msg of req.messages) {
    const text = extractContentText(msg.content);
    if (!text) continue;
    if (msg.role === "system" && messageCount === 0) {
      bytes += 30 + Buffer.byteLength(text, "utf8");
      messageCount++;
      continue;
    }
    if (msg.role === "user") {
      bytes += 28 + Buffer.byteLength(text, "utf8");
      messageCount++;
    }
    // assistant/tool fall through: matches curator's per-line skip.
  }
  bytes += 15 + (messageCount > 0 ? messageCount - 1 : 0);
  bytes += toolsBytes;
  return bytes;
}

/**
 * Estimate the number of tokens a model's tokenizer would produce for a
 * given OpenAIRequest, without actually running a tokenizer.
 *
 * Text content (user/assistant messages, tool names, function arguments)
 * is estimated at ~4 characters per token — the typical ratio for English
 * prose. JSON structural overhead (field names, braces, quotes, colons,
 * commas) is estimated at ~2 characters per token — JSON is denser than
 * natural language, so a tighter ratio is appropriate.
 *
 * The two ratios are derived from the same insight: a tokenizer splits on
 * whitespace boundaries and subword units, which means a given character
 * in natural language carries fewer tokens per byte than the same character
 * in JSON syntax. Using separate rates per component produces a per-request
 * total that's closer to what the model's tokenizer would produce than the
 * naive `estimateBytes / 3` heuristic, which treats all bytes uniformly.
 */
export function estimateTokens(req: OpenAIRequest): number {
  const json = JSON.stringify(req);
  const totalBytes = Buffer.byteLength(json, "utf8");

  // Extract all text content across every message to measure its byte
  // contribution separately from the JSON structural overhead. Counting
  // characters (~4 chars/token for prose) rather than bytes avoids the
  // UTF-8 multi-byte-vs-ASCII skew that the old `bytes / 3` heuristic
  // introduced (text with accents or emoji would over-estimate).
  const textParts: string[] = [];

  // System prompt (index 0 when role === "system").
  for (const msg of req.messages) {
    extractTextContent(msg, textParts);
  }

  // Tool definitions — the `description` and `parameters` fields are
  // prose-like text; the `name` is short but still counts toward tokens.
  if (req.tools) {
    for (const t of req.tools) {
      textParts.push(t.function.name);
      if (t.function.description) textParts.push(t.function.description);
      textParts.push(JSON.stringify(t.function.parameters));
    }
  }

  const allText = textParts.join("");
  const textChars = allText.length;

  // Text token estimate: ~4 characters per token for natural language.
  const textTokens = Math.ceil(textChars / 4);

  // Structural JSON overhead: everything in the serialized form that isn't
  // text content (field names like "role", "content", "tool_calls"; braces,
  // quotes, colons, commas; the `model` and `max_tokens` fields). Measured
  // as byte difference because the structural parts are all ASCII (each
  // char = 1 byte) and subtracting the text bytes is exact.
  const textBytes = Buffer.byteLength(allText, "utf8");
  const overheadBytes = totalBytes - textBytes;
  const overheadTokens = Math.ceil(Math.max(0, overheadBytes) / 2);

  return textTokens + overheadTokens;
}

/** Push the text content of a single message into `parts`. Handles string
 * content, array content (text parts + image_url URLs), and tool_calls
 * (function name + arguments JSON). Tool call IDs and extra_body vendor
 * metadata are structural overhead, not text, so they're excluded from the
 * text-chars count — they contribute to the `overheadBytes / 2` ratio
 * instead. */
function extractTextContent(msg: OpenAIMessage, parts: string[]): void {
  if (typeof msg.content === "string") {
    if (msg.content) parts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") parts.push(part.text);
      if (part.type === "image_url") parts.push(part.image_url.url);
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push(tc.function.name);
      parts.push(tc.function.arguments);
      if (tc.extra_content) parts.push(JSON.stringify(tc.extra_content));
    }
  }
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
 *  When `warnRatio` is set (default 0.75), pre-emptively truncate
 *  oldest conversation turns when the request exceeds `maxBytes *
 *  warnRatio` — even if it's still under `maxBytes` — keeping the
 *  conversation always below the warning threshold and preventing
 *  the hard 413 entirely.
 *
 * Algorithm:
 *  1. Clone the request so the caller's reference is untouched.
 *  2. Compute initial size. If already under `maxBytes` AND under
 *     `maxBytes * warnRatio`, return unchanged (no strip).
 *  3. If `maxBytes * warnRatio < initialBytes <= maxBytes`, this is
 *     a pre-emptive warning: run `truncateOldestMessages` to bring
 *     the body back under the warning threshold. No images are
 *     stripped (they were fine at the hard-cap level; the warning
 *     is about conversation size growth).
 *  4. If `initialBytes > maxBytes`, proceed with the existing hard-cap
 *     path: strip oldest inline-base64 images until the body fits
 *     `maxBytes`, falling through to text truncation as a last
 *     resort. Returns `stillOverLimit: true` only when even
 *     everything stripped+truncated can't fit.
 *
 * Only `data:`-prefixed image_url parts are eligible. URL-only image
 * references stay (their URL string is the byte cost and is already
 * small). Both message content and tool-result content are walked
 * because `anthropicMessageToOpenAI` emits content arrays there too. */
export function fitRequestToSize(req: OpenAIRequest, maxBytes: number, warnRatio: number = 0.75): FitRequestResult {
  const initialBytes = serializeRequestBytes(req);
  const warnBytes = Math.floor(maxBytes * warnRatio);

  // Below both the hard cap AND the warning threshold: nothing to do.
  if (initialBytes <= warnBytes) {
    return { request: req, stripped: 0, truncatedMessages: 0, stillOverLimit: false, initialBytes, finalBytes: initialBytes };
  }

  // Above the warning threshold but still UNDER the hard cap: run
  // pre-emptive text truncation to bring the body back under the
  // warning threshold. No images are stripped (they were fine at
  // the hard-cap level; the warning is about conversation size
  // growth). If truncation can't bring it under the warning level
  // (e.g. a single huge turn with no old messages), we still pass
  // the request through — the hard cap will catch it on the next
  // turn.
  if (initialBytes <= maxBytes) {
    const truncated = truncateOldestMessages(req, initialBytes, warnBytes);
    if (truncated) {
      // Final check: if still over the warning threshold even after
      // truncation, return what we have rather than blocking the
      // request. The hard cap hasn't been reached yet.
      if (truncated.stillOverLimit) {
        return { ...truncated, stillOverLimit: false };
      }
      return truncated;
    }
    // Nothing to truncate (only 2 messages) — let the request through.
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

/** Helper: try to fit a single message's content under the size cap by
 *  truncating oversized text portions. Handles both string content
 *  (existing behavior — keep head 60 % / tail 40 %) and array content
 *  (agent conversations with tool results, file reads, etc.). Mutates
 *  `messages[idx].content` in place when truncation is possible.
 *  Returns `{ fits: boolean, bytes: number }` — the `bytes` field
 *  lets the caller avoid a redundant re-serialization.
 *
 *  For array content, the function finds the largest text parts and
 *  truncates them progressively (keeping head ~60 % / tail ~40 %),
 *  skipping parts whose text is already small (< 1 KB). Inline base64
 *  image parts are replaced with the text placeholder since they are
 *  the largest per-part byte consumers. Returns `{ fits: false }`
 *  when even the content at index 0 (system prompt) alone exceeds the
 *  cap — no amount of per-part truncation can save it. */
function truncateMessageContent(
  messages: OpenAIMessage[],
  idx: number,
  maxBytes: number,
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[],
): { fits: boolean; bytes: number } {
  const msg = messages[idx];
  const measure = () => serializeRequestBytes({ model: "", messages, tools: tools ?? undefined, max_tokens: undefined, stream: undefined });
  if (typeof msg.content === "string") {
    // Keep truncating until under the cap or the content is too small to
    // continue.  A single pass to 25 % may not suffice when the content
    // is enormous (a tool result with a 100 MB file), so we progressively
    // reduce the target fraction (0.25, 0.15, 0.10, 0.05) until the
    // request fits or the content is below 100 KB (truncating further
    // wouldn't save much).
    if (msg.content.length <= 1024) return { fits: false, bytes: 0 };
    const fractions = [0.25, 0.15, 0.10, 0.05];
    for (const frac of fractions) {
      const target = Math.max(512, Math.floor(msg.content.length * frac));
      msg.content = msg.content.slice(0, Math.floor(target * 0.6)) +
        "\n...[truncated by Custos to fit request size limit]...\n" +
        msg.content.slice(-Math.floor(target * 0.4));
      const bytes = measure();
      if (bytes <= maxBytes) return { fits: true, bytes };
      // If text is already small enough that further truncation is
      // unlikely to help, stop early.
      if (msg.content.length < 100 * 1024) break;
    }
    // Still over after the most aggressive truncation — measure once more
    // and return the result.
    return { fits: false, bytes: measure() };
  }
  if (Array.isArray(msg.content)) {
    const parts = msg.content;
    let changed = false;

    // Pass 1: replace inline base64 images with the text placeholder.
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (isInlineBase64ImagePart(p)) {
        parts[i] = OMITTED_IMAGE_PLACEHOLDER;
        changed = true;
      }
    }
    if (changed) {
      const bytes = measure();
      if (bytes <= maxBytes) return { fits: true, bytes };
    }

    // Pass 2: find and truncate the largest text parts, one at a time,
    // until under the cap or no part is > 1 KB.  Each text part gets
    // the same progressive-fraction treatment as the string branch
    // (0.25 → 0.15 → 0.10 → 0.05) so a single enormous tool-result
    // text is progressively reduced until the full request fits.
    const textParts: Array<{ idx: number; part: OpenAITextPart }> = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === "text" && p.text.length > 1024) {
        textParts.push({ idx: i, part: p });
      }
    }

    // Sort largest-first by text byte length.
    textParts.sort((a, b) => Buffer.byteLength(b.part.text, "utf8") - Buffer.byteLength(a.part.text, "utf8"));

    const fractions = [0.25, 0.15, 0.10, 0.05];
    for (const { idx } of textParts) {
      const p = parts[idx] as OpenAITextPart;
      for (const frac of fractions) {
        const target = Math.max(512, Math.floor(p.text.length * frac));
        p.text = p.text.slice(0, Math.floor(target * 0.6)) +
          "\n...[truncated by Custos to fit request size limit]...\n" +
          p.text.slice(-Math.floor(target * 0.4));
        const bytes = measure();
        if (bytes <= maxBytes) return { fits: true, bytes };
        // Stop shrinking this part if it's already small enough that
        // further truncation won't meaningfully help.
        if (p.text.length < 100 * 1024) break;
      }
    }
  }
  return { fits: false, bytes: 0 };
}

/** True when an OpenAI message looks like a provider error that was echoed
 *  back into the conversation history. The claude subprocess receives error
 *  responses and includes them as assistant/user messages in the next
 *  request. Over time these accumulate and waste the request-size budget
 *  without contributing useful context. The pre-filter below strips them
 *  before age-based removal, so a conversation bloated with retry loops
 *  shrinks to useful exchanges first.
 *
 *  Detection patterns (extensible):
 *    - Assistant message whose string content starts with "API Error:"
 *    - Any message whose content (string or text-part) contains "Run failed:"
 *      or "Request too large" — the gateway's own 413 phrasing and the
 *      PM agent's failure reports both use this pattern.
 *
 *  The check is intentionally loose to catch both the claude subprocess's
 *  raw error echo AND the PM agent's structured context summary. A false
 *  positive would remove a legitimate message that happens to contain the
 *  words "API Error" in its text — extremely rare in practice since normal
 *  conversation exchanges don't discuss gateway error messages. */
function isErrorMessage(msg: OpenAIMessage): boolean {
  const text = typeof msg.content === "string" ? msg.content :
    Array.isArray(msg.content) ? msg.content.map((p) => (p as OpenAITextPart).text ?? "").join(" ") :
    "";
  // Assistant messages that directly echo provider errors start with
  // exactly this prefix.
  if (msg.role === "assistant" && text.startsWith("API Error:")) return true;
  // Any role — the PM agent embeds failure reports in user-role session
  // context, and claude may re-echo errors as user messages on retry.
  if (text.includes("Run failed:") || text.includes("API Error:")) return true;
  // Gateway-level 413 the claude subprocess includes verbatim.
  if (text.includes("Request too large")) return true;
  return false;
}

/** Remove the oldest messages (everything after the system prompt) from
 *  an OpenAI request until its serialized body fits `maxBytes`. Keeps the
 *  system prompt at index 0 and the newest messages. Returns a
 *  FitRequestResult when truncation succeeds (stillOverLimit can still be
 *  true if even keeping only the system + one message still exceeds the
 *  limit), or undefined when the request has < 3 messages total (nothing
 *  worth dropping).
 *
 *  Agent-style conversations (the dominant case) produce messages where
 *  the only `role: "user"` entry is the initial prompt at index 1 — every
 *  subsequent tool_result becomes `role: "tool"` in the OpenAI translation.
 *  A user-message search would find `lastUserIdx = 1` and refuse to
 *  truncate anything. The role-agnostic approach below removes the oldest
 *  messages progressively until the body fits (or only 2 messages remain),
 *  which works for both traditional chat conversations and tool-result-heavy
 *  agent turns even when the conversation is far past the size cap.
 *
 *  ERROR-FIRST PRE-FILTER: Before the age-based loop, the function scans
 *  for messages whose content matches known error patterns (
 *  `isErrorMessage`). These error exchanges are dead weight — they echo
 *  provider failures back into the conversation without adding useful
 *  context. Stripping them first often brings the body under the cap in
 *  one pass, avoiding the age-based loop entirely for conversations
 *  bloated by retry storms.
 *
 *  LOOPING BEHAVIOR: A single 50% pass may not suffice for very large
 *  conversations — even after error stripping, a 131MB session file
 *  reduced by 50% still leaves ~65MB, which exceeds most caps. The old
 *  one-shot approach returned `stillOverLimit: true` after that single
 *  attempt, blocking the request entirely. Now the function keeps
 *  removing 25% of remaining messages per iteration until the body fits
 *  or only 2 messages survive, at which point the limit really can't be
 *  satisfied (unless the system prompt alone exceeds the cap, which is
 *  an operator config issue). */
function truncateOldestMessages(req: OpenAIRequest, currentBytes: number, maxBytes: number): FitRequestResult | undefined {
  // Need at least system (0) + 2 more messages to have anything worth
  // trimming. A single turn with only its system prompt, one user, and
  // one assistant response has no "old" material to drop.
  if (req.messages.length < 3) return undefined;

  const clone: OpenAIRequest = JSON.parse(JSON.stringify(req));
  let removedCount = 0;

  // ERROR-FIRST PASS: Strip known error-pattern messages before the
  // age-based loop. In a conversation saturated with retry errors (e.g.
  // a PM agent that retried 50 times before succeeding), this single
  // pass removes all the dead weight at once — no need to touch healthy
  // exchanges. Check every non-system message; system prompt at index 0
  // is never removed.
  let i = clone.messages.length - 1;
  while (i >= 1) {
    if (isErrorMessage(clone.messages[i])) {
      clone.messages.splice(i, 1);
      removedCount++;
    }
    i--;
  }
  if (removedCount > 0) {
    const finalBytes = serializeRequestBytes(clone);
    if (finalBytes <= maxBytes) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes,
      };
    }
    // Error pass alone wasn't enough — fall through to age-based removal.
  }

  // AGE-BASED LOOP: remove oldest messages in chunks of ~25% until the
  // body fits or only the system prompt + 1 message remain. The old
  // one-shot 50% pass was insufficient for conversations whose <newest
  // half> alone exceeds the cap (e.g. a 131MB session file's newest
  // 50% = ~65MB).
  while (clone.messages.length > 2) {
    // Remove the oldest ~25% of remaining non-system messages.
    const chunkSize = Math.max(1, Math.floor((clone.messages.length - 1) * 0.25));
    clone.messages.splice(1, chunkSize);
    removedCount += chunkSize;

    const finalBytes = serializeRequestBytes(clone);
    if (finalBytes <= maxBytes) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes,
      };
    }
  }

  // Even with only system + 1 message, still over the cap. The message
  // itself may be enormous (a session-context message containing hundreds
  // of "Run failed" entries can be tens of MB alone). Try truncating
  // the system prompt content first, then the first user message, before
  // giving up.
  //
  // SYSTEM PROMPT TRUNCATION: Cut the system message to ~25% of its
  // original size by taking the first and last portions. The system
  // prompt is the agent instructions — losing the middle is better than
  // a 413.
  if (clone.messages.length >= 1) {
    const result = truncateMessageContent(clone.messages, 0, maxBytes, clone.tools);
    if (result.fits) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes: result.bytes,
      };
    }
  }

  // FIRST USER MESSAGE TRUNCATION: If still over, truncate the first
  // user/assistant message (index 1) to ~25% of its original size. This
  // is the session context that accumulates "Run failed" entries over
  // time. Truncating it preserves decisions and key info from the head
  // and tail while shedding the bloated middle.
  if (clone.messages.length >= 2) {
    const result = truncateMessageContent(clone.messages, 1, maxBytes, clone.tools);
    if (result.fits) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes: result.bytes,
      };
    }
  }

  // Even after truncating both system and user message content, still
  // over the cap. Nothing more we can do.
  const finalBytes = serializeRequestBytes(clone);
  return {
    request: clone,
    stripped: 0,
    truncatedMessages: removedCount,
    stillOverLimit: true,
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
