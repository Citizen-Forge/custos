// Translates between the Anthropic Messages format (what this gateway speaks
// to Claude Code) and the OpenAI-compatible chat/completions format that
// Ollama, OpenAI, DeepSeek, Gemini (via its compat layer), OpenRouter, Mistral,
// Groq, xAI, Bedrock, etc. expose.
//
// The actual logic lives under ./translate/, split by concern:
//   - translate/types.ts    -- the OpenAI wire-format types shared by both
//                              directions (not part of this module's public
//                              surface; internal to ./translate/).
//   - translate/request.ts  -- Anthropic -> OpenAI (toOpenAIRequest and the
//                              vendor-metadata carrier strategy; see its
//                              header comment for the full design).
//   - translate/fit-size.ts -- fits an over-budget OpenAIRequest under a
//                              provider's maxRequestBytes cap.
//   - translate/response.ts -- OpenAI -> Anthropic (fromOpenAIResponse).
//
// This file re-exports exactly what those modules expose publicly, so
// every existing `from "./openai-translate.js"` import (openai-compatible.ts,
// the test suite) keeps working unchanged.
export type { OpenAIContentPart, OpenAIImagePart, OpenAITextPart } from "./translate/types.js";
export { blockText, isOpenAIImagePart, providerMetadataOf, toOpenAIRequest, vendorMetadataOf } from "./translate/request.js";
export type { FitRequestResult } from "./translate/fit-size.js";
export { estimateCompactPassBytes, estimateTokens, fitRequestToSize, serializeRequestBytes } from "./translate/fit-size.js";
export { fromOpenAIResponse, mapFinishReason } from "./translate/response.js";
