// Byte/token estimators. Pure measurement functions -- unlike the
// strip/truncate path in ./truncate.ts, these never mutate a request,
// they only report what a request costs.
import { extractContentText } from "../../../memory/curator.js";
import type { OpenAIMessage, OpenAIRequest } from "../types.js";

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
