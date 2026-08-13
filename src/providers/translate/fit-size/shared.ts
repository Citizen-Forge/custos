// Pure helpers and types shared across fit-size.ts's estimate/truncate
// sub-modules: the placeholder text, the base64-image-part predicate,
// the byte-count serializer, and the FitRequestResult return shape.
import { isOpenAIImagePart } from "../request.js";
import type { OpenAIContentPart, OpenAIRequest, OpenAITextPart } from "../types.js";

/** Placeholder inserted when an image part is stripped from a message to
 *  fit the upstream's request size limit. Long enough that a reader
 *  scanning a multi-turn conversation can tell what happened, short
 *  enough that every replacement saves a real amount of bytes
 *  (compared to the kilobyte-or-larger base64 payload it replaces). */
export const OMITTED_IMAGE_PLACEHOLDER: OpenAITextPart = {
  type: "text",
  text: "[previous image omitted — request size limit reached for this provider]",
};

/** True when a content part is a base64 inline image (`data:image/...;base64,...`).
 *  These are the parts that contribute the most bytes to a serialized body,
 *  so the size-fitting helper strips exactly this kind and leaves URL-only
 *  image references untouched. */
export function isInlineBase64ImagePart(part: OpenAIContentPart): boolean {
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
