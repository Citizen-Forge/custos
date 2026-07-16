import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import { toOpenAIRequest, fromOpenAIResponse, mapFinishReason } from "./openai-translate.js";
import type { Provider, ProviderResponse } from "./types.js";

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";

  constructor(private readonly config: OllamaProviderConfig) {}

  async complete(request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const openaiRequest = toOpenAIRequest(request, this.config.model);

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openaiRequest),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`ollama: unreachable at ${this.config.baseUrl} (${(err as Error).message})`);
    }

    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderUnavailableError(`ollama: HTTP ${res.status}`);
      }
      const text = await res.text().catch(() => "");
      return { status: res.status, headers: res.headers, body: new Blob([text]).stream() };
    }

    if (openaiRequest.stream) {
      return { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: translateStream(res, request.model) };
    }

    const openaiJson = await res.json();
    const anthropicJson = fromOpenAIResponse(openaiJson as never, request.model);
    const body = new Blob([JSON.stringify(anthropicJson)]).stream();
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body };
  }
}

/**
 * Best-effort OpenAI SSE -> Anthropic SSE translation for a single text
 * and/or single tool-call turn. Ollama rarely emits parallel tool calls in
 * one turn, so this doesn't attempt to multiplex multiple concurrent
 * content blocks.
 */
function translateStream(openaiRes: Response, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = openaiRes.body!.getReader();

  let messageStarted = false;
  let textBlockOpen = false;
  let toolBlockOpen = false;
  let buffer = "";
  let closed = false;

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
        // (shouldn't normally happen -- Ollama always sends one -- but
        // don't leave the client hanging if it does).
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
            delta: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
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
          if (!toolBlockOpen) {
            toolBlockOpen = true;
            controller.enqueue(
              encoder.encode(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "tool_use", id: call.id ?? "", name: call.function?.name ?? "" },
                }),
              ),
            );
          }
          if (call.function?.arguments) {
            controller.enqueue(
              encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: call.function.arguments } })),
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
