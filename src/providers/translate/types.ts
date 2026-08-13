// Shared OpenAI chat/completions wire-format types used across the
// request-building, size-fitting, and response-parsing modules. None of
// these are Anthropic-side types (see ../../types.js for those) -- this is
// purely the shape this gateway sends to/receives from an OpenAI-compatible
// upstream.
import type { VendorMetadata } from "../../types.js";

export interface OpenAIToolCall {
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

export interface OpenAIMessage {
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

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[];
}

export interface OpenAIResponseChoiceMessage {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Vendor-specific per-message metadata on the response side. Gemini
   * reads `extra_content.google.thought_signature` here. Other vendors
   * place per-message state here too. */
  extra_content?: VendorMetadata;
}

export interface OpenAIResponse {
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
