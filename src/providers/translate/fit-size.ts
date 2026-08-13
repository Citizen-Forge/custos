// Fits an OpenAIRequest under a provider's request-size cap (see
// OpenAICompatibleInstanceConfig.maxRequestBytes) by stripping the oldest
// inline-base64 images first, then falling back to truncating the oldest
// conversation turns -- so providers with smaller request-size limits
// (Groq: 32 MB, OpenRouter free-tier: per-model) keep working as
// conversations accumulate images and tool-result text.
import { extractContentText } from "../../memory/curator.js";
import { isOpenAIImagePart } from "./request.js";
import type { OpenAIContentPart, OpenAIMessage, OpenAIRequest, OpenAITextPart } from "./types.js";

/** Placeholder inserted when an image part is stripped from a message to
 *  fit the upstream's request size limit. Long enough that a reader
 *  scanning a multi-turn conversation can tell what happened, short
 *  enough that every replacement saves a real amount of bytes
 *  (compared to the kilobyte-or-larger base64 payload it replaces). */
const OMITTED_IMAGE_PLACEHOLDER: OpenAITextPart = {
  type: "text",
  text: "[previous image omitted — request size limit reached for this provider]",
};

/** True when a content part is a base64 inline image (`data:image/...;base64,...`).
 *  These are the parts that contribute the most bytes to a serialized body,
 *  so the size-fitting helper strips exactly this kind and leaves URL-only
 *  image references untouched. */
function isInlineBase64ImagePart(part: OpenAIContentPart): boolean {
  return isOpenAIImagePart(part) && part.image_url.url.startsWith("data:");
}

/** Serialize an OpenAIRequest to a UTF-8 byte count. The size cap is
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
