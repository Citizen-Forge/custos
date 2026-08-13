// Fits an OpenAIRequest under a provider's request-size cap (see
// OpenAICompatibleInstanceConfig.maxRequestBytes) by stripping the oldest
// inline-base64 images first, then falling back to truncating the oldest
// conversation turns -- so providers with smaller request-size limits
// (Groq: 32 MB, OpenRouter free-tier: per-model) keep working as
// conversations accumulate images and tool-result text.
//
// Split under ./fit-size/: shared.ts (the placeholder/predicate/byte-count
// primitives and the FitRequestResult type used by both this file and
// truncate.ts), estimate.ts (byte/token estimators -- pure measurement,
// no relation to the strip/truncate mutation path), truncate.ts (the
// text-truncation fallback once image-stripping has nothing left to
// strip). fitRequestToSize itself -- the orchestrating entry point that
// decides strip-vs-truncate-vs-pass-through -- stays here, since it's
// the one piece that ties every sub-module's output together in a single
// sequenced decision tree.
import type { OpenAIContentPart, OpenAIRequest } from "./types.js";
import { OMITTED_IMAGE_PLACEHOLDER, isInlineBase64ImagePart, serializeRequestBytes, type FitRequestResult } from "./fit-size/shared.js";
import { truncateOldestMessages } from "./fit-size/truncate.js";

export { serializeRequestBytes } from "./fit-size/shared.js";
export type { FitRequestResult } from "./fit-size/shared.js";
export { estimateCompactPassBytes, estimateTokens } from "./fit-size/estimate.js";

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
