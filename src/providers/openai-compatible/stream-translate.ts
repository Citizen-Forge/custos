// Best-effort OpenAI SSE -> Anthropic SSE translation for a single text
// and/or single tool-call turn. Most of these providers rarely emit
// parallel tool calls in one turn, so this doesn't attempt to multiplex
// multiple concurrent content blocks. Only verified live against Ollama;
// other providers' streaming quirks (if any) aren't individually checked.
import { mapFinishReason, vendorMetadataOf } from "../openai-translate.js";
import type { VendorMetadata } from "../../types.js";

/**
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
