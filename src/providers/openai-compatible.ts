import { ProviderUnavailableError, type AnthropicMessagesRequest, type VendorMetadata } from "../types.js";
import { toOpenAIRequest, fromOpenAIResponse, mapFinishReason, vendorMetadataOf, fitRequestToSize, estimateTokens, serializeRequestBytes, estimateCompactPassBytes } from "./openai-translate.js";
import { parseRetryAfterMs } from "./retry-header.js";
import { looksRateLimited } from "./rate-limit-signature.js";
import type { CompleteOptions, Priority, Provider, ProviderResponse } from "./types.js";
import type { PricingConfig, BudgetConfig } from "./spend-tracker.js";

export interface OpenAICompatibleInstanceConfig {
  /** Full path prefix up to (not including) "/chat/completions" -- e.g.
   * "http://localhost:11434/v1", "https://api.openai.com/v1",
   * "https://generativelanguage.googleapis.com/v1beta/openai". Matches how
   * OpenAI SDKs configure `base_url`, which several of these providers
   * (Gemini in particular) rely on to place the compat layer at a
   * non-"/v1" path. */
  baseUrl: string;
  model: string;
  /** Omit for servers that don't need auth (a local Ollama). */
  apiKey?: string;
  /** Omit for providers with no per-call billing to track (a local Ollama,
   * or anything covered by a flat subscription) -- required for budget
   * enforcement to mean anything, since cost has to be computed somehow. */
  pricing?: PricingConfig;
  /** Omit for unlimited. Requires `pricing` to actually take effect. */
  budget?: BudgetConfig;
  /** Max concurrent requests this instance will handle. Setting 1 forces
   * strict serial -- the canonical case is a local Ollama on consumer
   * hardware where two simultaneous requests don't get done any faster
   * and may thrash VRAM. The runtime wraps this instance in a
   * ThrottledProvider; further requests queue FIFO until a slot frees,
   * and a busy local does not block a free Anthropic upstream because
   * each provider has its own queue. Unset means unlimited -- the
   * gateway imposes no additional wait on upstreams that can take the
   * full request rate. */
  maxConcurrent?: number;
  /** Requests per minute limit. When set, the throttle proactively shapes
   * traffic instead of only reacting to 429s. Set to 10 for Gemini Free. */
  rpmLimit?: number;
  /** Per-instance throttle priority override. The router's task-derived
   *  default (chat/perms/complexity classifiers -> "interactive";
   *  memoryCurator -> "background") still applies unless the instance
   *  pins its own. Tag Ollama as "background" so chat traffic to it
   *  doesn't lock out queued background work on its single slot -- the
   *  converse of the priority-queue's anti-starvation default, which
   *  assumes interactive callers should win. Omit for the router default;
   *  the admin UI's Add form defaults to "interactive" for non-Ollama
   *  presets so non-Ollama instances round-trip through the save path
   *  unchanged. Caller-supplied `options.priority` always wins over both. */
  priority?: Priority;
  /** When true, late vendor metadata (arriving after
   * `content_block_start` has fired) is emitted inline as a custom
   * `content_block_delta` with `delta.type === "vendor_metadata_delta"`.
   * Default is false: strict Anthropic SDK parsers surface
   * "unknown event" warnings on unrecognized delta types, so this
   * stays opt-in. Turn the flag on for instances whose downstream
   * client knows to honor the carrier and merge it onto the
   * still-open tool_use block. See types.ts VendorMetadataDeltaEvent
   * for the wire shape pinned by the streaming tests. */
  emitLateMetadataDelta?: boolean;
  /** Maximum size, in bytes UTF-8, of a single /chat/completions request
   *  body sent to this upstream. When set, `complete()` measures the
   *  serialized OpenAI request and, if over the cap, replaces the
   *  oldest inline-base64 image parts with a text placeholder until
   *  the body fits. Set this for providers with smaller upstream
   *  limits -- Groq hard-caps at 32 MB, OpenRouter free-tier has
   *  varying per-model caps. Leaving unset keeps every image in full,
   *  which is correct for upstream-tolerant hosts (Anthropic, OpenAI
   *  API key, Mistral). The fit is purely best-effort: a request with
   *  no inline images that's still over the limit fails loud so the
   *  upstream's error surfaces to the operator instead of being
   *  silently mangled. */
  maxRequestBytes?: number;
  /** Pre-emptive truncation threshold, expressed as a fraction of
   *  `maxRequestBytes`. When the serialized request exceeds
   *  `maxRequestBytes * maxRequestBytesWarnRatio`, the oldest
   *  conversation turns are truncated BEFORE the request reaches the
   *  hard cap, keeping the conversation always below the limit.
   *  Default 0.75. Only meaningful when `maxRequestBytes` is set. */
  maxRequestBytesWarnRatio?: number;
  /** Per-model settings, keyed by model name. Resolved at dispatch time
   * when `modelOverride` (via `CompleteOptions`) supplies a model
   * different than the default `model`. Populated at provider
   * construction from `ProviderDef.models` in `runtime.ts`. */
  models?: Record<string, { maxOutputTokens?: number; maxContextWindow?: number }>;
}

/**
 * Any provider speaking the OpenAI chat/completions wire format --
 * OpenAI itself, Ollama, DeepSeek, Gemini (via its OpenAI-compat layer),
 * Groq, Mistral, xAI, OpenRouter, etc. `name` is the config-file instance
 * key (e.g. "openai", "ollama-fast"), used for cooldown tracking and
 * error messages -- it does not need to match the actual provider brand.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly config: OpenAICompatibleInstanceConfig,
  ) {}

  async complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse> {
    // clientBetaHeader is Anthropic-specific and intentionally ignored here.
    const { signal, modelOverride } = options ?? {};
    let openaiRequest = toOpenAIRequest(request, modelOverride ?? this.config.model);

    // Clamp max_tokens per-model when the provider's config carries a
    // per-model limit. Different models on the same provider (e.g. Groq's
    // Qwen 3.6 at 16384 vs Llama 3.1 at 8192) have different output-token
    // caps, and the upstream rejects requests whose max_tokens exceeds the
    // model-specific limit with a 400. Resolve the effective model from
    // modelOverride (what the GlobalQueue dispatched) or the provider's
    // default model, then look up the cap from the per-model settings map.
    // No map == no clamping (legacy instances that don't carry models).
    const effectiveModel = modelOverride ?? this.config.model;
    const modelCfg = this.config.models?.[effectiveModel];
    if (modelCfg?.maxOutputTokens !== undefined && openaiRequest.max_tokens !== undefined) {
      openaiRequest.max_tokens = Math.min(openaiRequest.max_tokens, modelCfg.maxOutputTokens);
    }

    // Warn when the serialized request exceeds the model's context window.
    // Token count uses the per-message estimator (~4 chars/token for text,
    // ~2 chars/token for JSON overhead) rather than the naive `bytes / 3`
    // heuristic — the per-component estimate is closer to what the model's
    // tokenizer produces by treating prose and structural JSON at different
    // densities. This is advisory only — the request is still sent because
    // the upstream enforces its own limit and the estimate is approximate.
    // Logged at `warn` level so it reaches the admin panel and the logs.
    if (modelCfg?.maxContextWindow !== undefined) {
      const estimatedTokens = estimateTokens(openaiRequest);
      if (estimatedTokens > modelCfg.maxContextWindow) {
        console.warn(`[${this.name}] model ${effectiveModel}: estimated ${estimatedTokens} tokens exceeds ${modelCfg.maxContextWindow} context window`);
      }
    }

    // Per-instance request size cap (see OpenAICompatibleInstanceConfig.maxRequestBytes).
    // When configured, the request is fitted by stripping oldest inline-base64 image parts.
    // A request that's still over the cap after all stripping has nothing left to drop
    // (no images, or all remaining images are tiny URL references); surface a clear 413
    // to claude-code rather than silently shipping an over-limit body the upstream will
    // reject with its own generic message -- Groq's "accumulated images and attachments"
    // error in particular doesn't tell the operator which conversation to compact.

    // Diagnostic: capture pre-fit bytes and what curator.ts's runCompactPass
    // algorithm would estimate for the same conversation. The comparison
    // (preFit vs compactPass-est) reveals both the curator's per-line
    // underestimation and the fact that 413s often hit requests before
    // they ever get persisted to a session file -- so the curator can't see
    // them at all. Gated on maxRequestBytes like the block below so log
    // volume scales with providers that carry a size cap.
    if (this.config.maxRequestBytes !== undefined) {
      const preFitBytes = serializeRequestBytes(openaiRequest);
      const compactPassEstimate = estimateCompactPassBytes(openaiRequest);
      console.log(`[dispatch-byte-trace] ${this.name}: preFit=${preFitBytes}B compactPass-est=${compactPassEstimate}B ratio=${preFitBytes > 0 ? (compactPassEstimate / preFitBytes).toFixed(3) : "n/a"} cap=${this.config.maxRequestBytes}B`);
    }

    if (this.config.maxRequestBytes !== undefined) {
      const warnRatio = Math.min(1, Math.max(0.1, this.config.maxRequestBytesWarnRatio ?? 0.75));
      const fit = fitRequestToSize(openaiRequest, this.config.maxRequestBytes, warnRatio);
      if (fit.stripped > 0) {
        console.log(`[${this.name}] stripped ${fit.stripped} image(s) from request to fit ${this.config.maxRequestBytes}B cap (${fit.initialBytes}B -> ${fit.finalBytes}B)`);
      }
      if (fit.truncatedMessages > 0) {
        console.log(`[${this.name}] truncated ${fit.truncatedMessages} old message(s) from request (${fit.initialBytes}B -> ${fit.finalBytes}B, cap=${this.config.maxRequestBytes}B, warnRatio=${warnRatio})`);
      }
      openaiRequest = fit.request;
      // Diagnostic: log post-fit bytes + strip/truncate count. Reached
      // only when fit succeeded -- the stillOverLimit return exits
      // immediately below. This is the size the upstream actually sees.
      if (!fit.stillOverLimit) {
        const postFitBytes = Buffer.byteLength(JSON.stringify(openaiRequest), "utf8");
        console.log(`[dispatch-byte-trace] ${this.name}: postFit=${postFitBytes}B stripped=${fit.stripped} truncated=${fit.truncatedMessages}`);
      }
      if (fit.stillOverLimit) {
        const hadImages = fit.stripped > 0;
        const hadTruncation = fit.truncatedMessages > 0;
        let detail = "";
        if (hadImages && hadTruncation) detail = "after stripping all images and removing oldest turns";
        else if (hadImages) detail = "after stripping all inline images";
        else if (hadTruncation) detail = "after removing oldest conversation turns";
        else detail = "";
        return {
          status: 413,
          headers: new Headers({ "content-type": "application/json" }),
          body: new Blob([JSON.stringify({
            type: "error",
            error: {
              type: "request_too_large",
              message: `${this.name}: request is ${fit.finalBytes}B ${detail}exceeding the ${this.config.maxRequestBytes}B cap. Compact the conversation or use a provider with a larger limit.`,
            },
          })]).stream(),
        };
      }
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    // Diagnostic: log the wire bytes right before fetching, gated on
    // maxRequestBytes set so it scales with providers that have a cap.
    if (this.config.maxRequestBytes !== undefined) {
      const dispatchBytes = Buffer.byteLength(JSON.stringify(openaiRequest), "utf8");
      console.log(`[dispatch-byte-trace] ${this.name}: actually-sending=${dispatchBytes}B to ${this.config.baseUrl}/chat/completions`);
    }

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(openaiRequest),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`${this.name}: unreachable at ${this.config.baseUrl} (${(err as Error).message})`);
    }

    if (!res.ok) {
      // Capture the upstream's response body once -- it feeds both the
      // diagnostic trace below (we log the first 200 chars so an
      // operator can tell "Request too large" apart from "Daily quota
      // exhausted" or "Model decommissioned": the byte counts alone can't
      // disambiguate, but the upstream's literal response text can) and
      // the existing forward-to-client path at the bottom of this
      // block. Reads the body regardless of status because we don't
      // know yet whether 413 / 429 / 5xx / 4xx applies -- upstream
      // error envelopes are a few KB at most, so the cost is negligible.
      // A failed read (already-consumed stream, network blip) leaves
      // `upBodyText` as "" which downstream uses as an empty blob.
      let upBodyText = "";
      try { upBodyText = await res.text(); } catch { /* keep "" */ }

      // Diagnostic: distinguish an upstream 413 (we DID send a body and
      // Groq/etc rejected it) from our own fitRequestToSize
      // stillOverLimit return (which never reaches the fetch). Snippet
      // trimmed to 200 chars and whitespace-collapsed so log lines stay
      // readable when the upstream returns an escaped JSON block.
      if (res.status === 413 && this.config.maxRequestBytes !== undefined) {
        const sentBytes = Buffer.byteLength(JSON.stringify(openaiRequest), "utf8");
        const snippet = upBodyText.slice(0, 200).replace(/\s+/g, " ").trim();
        console.log(`[dispatch-byte-trace] ${this.name}: UPSTREAM-413 after-sending=${sentBytes}B cap=${this.config.maxRequestBytes}B body=${JSON.stringify(snippet)}`);
      }
      // Groq (and potentially other upstreams) report their TPM/RPM rate
      // limit as HTTP 413 ("Request too large ... on tokens per minute
      // (TPM)") instead of 429 -- indistinguishable from a genuine
      // payload-too-large rejection by status code alone. Sniffing the
      // body for rate-limit keywords routes it through the same
      // ProviderUnavailableError path as a real 429: cooldown gets
      // recorded and the GlobalQueue advances to the next entry in the
      // fallback set. Without this, the request "succeeds" as a 413
      // response as far as tryExecute() is concerned -- no cooldown, no
      // fallback -- and the caller's retry loop just hits the same
      // exhausted provider again.
      if (res.status === 413 && looksRateLimited(upBodyText)) {
        throw new ProviderUnavailableError(`${this.name}: rate limited (413 TPM/RPM)`, parseRetryAfterMs(res.headers));
      }
      if (res.status === 429 || res.status >= 500) {
        // Surface the upstream's Retry-After to the router so the
        // cooldown deadline matches reality. Without this, Gemini
        // Free-tier quota-exhausted responses (which carry a real
        // Retry-After value, often 30-300s, sometimes longer for
        // daily caps) would be silently downgraded to the router's
        // 60-second default — restarting the cooldown clock on the
        // next request and perpetuating 429s indefinitely because
        // the gateway keeps retrying before the upstream's quota
        // has regenerated. Falling back to undefined (rather than
        // fabricating a value) leaves the router's default-cooldown
        // path intact for responses without a Retry-After header.
        // The parser (src/providers/retry-header.ts) is shared with
        // Anthropic so seconds-vs-HTTP-date handling stays canonical
        // across providers.
        throw new ProviderUnavailableError(`${this.name}: HTTP ${res.status}`, parseRetryAfterMs(res.headers));
      }
      return { status: res.status, headers: res.headers, body: new Blob([upBodyText]).stream() };
    }

    if (openaiRequest.stream) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: translateStream(res, request.model, this.config.emitLateMetadataDelta ?? false),
      };
    }

    const openaiJson = await res.json();
    const anthropicJson = fromOpenAIResponse(openaiJson as never, request.model);
    const body = new Blob([JSON.stringify(anthropicJson)]).stream();
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body };
  }
}

/**
 * Best-effort OpenAI SSE -> Anthropic SSE translation for a single text
 * and/or single tool-call turn. Most of these providers rarely emit
 * parallel tool calls in one turn, so this doesn't attempt to multiplex
 * multiple concurrent content blocks. Only verified live against Ollama;
 * other providers' streaming quirks (if any) aren't individually checked.
 *
 * `emitLateMetadataDelta` lifts the late-vendor-metadata limitation:
 * when an upstream chunk's tool_call OR message-level extra_content
 * arrives AFTER `content_block_start` has already fired (so it can no
 * longer be hoisted into the block), and this flag is true, the
 * translator emits an inline `content_block_delta` with
 * `delta.type === "vendor_metadata_delta"` carrying just that
 * chunk's payload at the same `index` as the open tool_use block.
 * Default is false -- opt-in. See types.ts VendorMetadataDeltaEvent
 * for the wire shape.
 *
 * Exported so streaming can be exercised via a synthesized `Response`
 * in the test suite without going through network I/O.
 */
export function translateStream(openaiRes: Response, model: string, emitLateMetadataDelta = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = openaiRes.body!.getReader();

  let messageStarted = false;
  let textBlockOpen = false;
  let toolBlockOpen = false;
  let buffer = "";
  let closed = false;
  // Vendor metadata arrives alongside tool_call deltas (or message-level
  // alongside the same chunk). We have to capture it and inject it into
  // the next tool_use content_block_start, because once Anthropic's
  // `content_block_start` has fired there's no slot on the subsequent
  // deltas to patch a metadata field back into the content_block.
  //
  // This is a per-vendor-agnostic carrier: whatever shape the upstream
  // puts under `extra_content` (Gemini nests under `.google`, other
  // vendors may use top-level keys) is forwarded verbatim to
  // `content_block.provider_metadata`. Late vendor metadata (those
  // arriving *after* content_block_start has fired) are dropped -- a
  // documented limitation rather than a synthetic event the client
  // would have to learn about.
  const pendingToolMetadata: Record<number, VendorMetadata> = {};

  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, finishReason: string) => {
    if (closed) return;
    closed = true;
    if (textBlockOpen || toolBlockOpen) controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })));
    controller.enqueue(
      encoder.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: mapFinishReason(finishReason) }, usage: {} })),
    );
    controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" })));
    controller.close();
    void reader.cancel().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;

      const { done, value } = await reader.read();
      if (done) {
        // The upstream connection closed without an explicit finish_reason
        // (shouldn't normally happen, but don't leave the client hanging).
        finish(controller, "stop");
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice("data: ".length).trim();
        if (payload === "[DONE]") continue;

        const chunk = JSON.parse(payload) as {
          id: string;
          choices: {
            delta: {
              content?: string;
              tool_calls?: {
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
                /** Vendor-specific per-tool-call metadata. Forwarded as-is
                 * to the Anthropic content_block.provider_metadata. */
                extra_content?: Record<string, unknown>;
              }[];
              /** Vendor-specific per-message metadata. Used as a fallback
               * if a tool_call delta in the same chunk has no per-call
               * metadata of its own. */
              extra_content?: Record<string, unknown>;
            };
            finish_reason?: string | null;
          }[];
        };

        if (!messageStarted) {
          messageStarted = true;
          controller.enqueue(
            encoder.encode(
              sse("message_start", {
                type: "message_start",
                message: { id: chunk.id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
              }),
            ),
          );
        }

        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          if (!textBlockOpen) {
            textBlockOpen = true;
            controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
          }
          controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } })));
        }

        if (delta?.tool_calls?.length) {
          const call = delta.tool_calls[0];
          // Hoist any vendor metadata that arrived *in this chunk* for
          // this tool_call index into the pending bucket so the
          // content_block_start below can include it. Per-tool-call
          // wins; fall back to the message-level delta if the upstream
          // emits vendor metadata only once at the message level
          // alongside the first tool_call delta. Both shapes go through
          // the same validation as the non-streaming translator
          // (`vendorMetadataOf`) so the streaming carrier is no looser
          // than the non-streaming one.
          const callMeta = vendorMetadataOf(call.extra_content);
          const deltaMeta = vendorMetadataOf(delta.extra_content);
          const newMeta = callMeta ?? deltaMeta ?? undefined;

          if (newMeta) {
            if (!toolBlockOpen) {
              // Pre-start hoist: slot the metadata onto the next
              // content_block_start. (Same path this code already
              // took before the late-metadata flag existed; kept so
              // the gated-off behavior is bit-identical.)
              pendingToolMetadata[call.index] = newMeta;
            } else if (emitLateMetadataDelta) {
              // Late arrival: content_block_start has already fired,
              // so there's nowhere to hoist onto the block itself.
              // Emit an inline `vendor_metadata_delta` carrying
              // *just* this chunk's payload -- not a full re-emit
              // of the original hoist, which would be redundant for
              // a client that already saw it on content_block_start.
              // index matches the content_block_start so a custom
              // client merges it onto the right tool_use block.
              controller.enqueue(
                encoder.encode(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index: call.index,
                    delta: {
                      type: "vendor_metadata_delta",
                      provider_metadata: newMeta,
                    },
                  }),
                ),
              );
            }
            // else (toolBlockOpen && !emitLateMetadataDelta): the
            // existing documented-limitation path -- late metadata
            // is dropped. The streaming test
            // "drops late vendor metadata ... (documented
            // limitation)" pins this contract.
          }

          if (!toolBlockOpen) {
            toolBlockOpen = true;
            const meta = pendingToolMetadata[call.index];
            const contentBlock: Record<string, unknown> = {
              type: "tool_use",
              id: call.id ?? "",
              name: call.function?.name ?? "",
            };
            if (meta) contentBlock.provider_metadata = meta;
            controller.enqueue(
              encoder.encode(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: call.index,
                  content_block: contentBlock,
                }),
              ),
            );
          }
          if (call.function?.arguments) {
            controller.enqueue(
              encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: call.index, delta: { type: "input_json_delta", partial_json: call.function.arguments } })),
            );
          }
        }

        if (choice?.finish_reason) {
          finish(controller, choice.finish_reason);
          return;
        }
      }
    },
  });
}
