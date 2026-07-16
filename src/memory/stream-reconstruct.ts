import type { AnthropicContentBlock, AnthropicMessagesResponse } from "../types.js";

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      yield { event: eventLine?.slice("event: ".length) ?? "", data: JSON.parse(dataLine.slice("data: ".length)) };
    }
  }
}

interface BlockBuffer {
  type: string;
  text?: string;
  partialJson?: string;
  id?: string;
  name?: string;
}

/**
 * Reconstructs a normal (non-streaming-shaped) AnthropicMessagesResponse by
 * replaying an Anthropic-format SSE stream. Used to ingest streamed
 * exchanges into memory without holding up the live response to the
 * client -- called against a tee()'d copy of the stream, never the one
 * actually sent back to Claude Code.
 */
export async function reconstructFromAnthropicSSE(
  stream: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<AnthropicMessagesResponse> {
  let id = "";
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map<number, BlockBuffer>();

  for await (const evt of parseSSE(stream)) {
    switch (evt.event) {
      case "message_start": {
        const message = evt.data.message as { id?: string; usage?: { input_tokens?: number } } | undefined;
        id = message?.id ?? "";
        inputTokens = message?.usage?.input_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const index = evt.data.index as number;
        const block = evt.data.content_block as { type: string; id?: string; name?: string };
        blocks.set(index, {
          type: block.type,
          text: block.type === "text" ? "" : undefined,
          partialJson: block.type === "tool_use" ? "" : undefined,
          id: block.id,
          name: block.name,
        });
        break;
      }
      case "content_block_delta": {
        const index = evt.data.index as number;
        const buf = blocks.get(index);
        if (!buf) break;
        const delta = evt.data.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta") buf.text = (buf.text ?? "") + (delta.text ?? "");
        if (delta.type === "input_json_delta") buf.partialJson = (buf.partialJson ?? "") + (delta.partial_json ?? "");
        break;
      }
      case "message_delta": {
        const delta = evt.data.delta as { stop_reason?: string } | undefined;
        const usage = evt.data.usage as { output_tokens?: number } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
        break;
      }
      default:
        break;
    }
  }

  const content: AnthropicContentBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, buf]) => {
      if (buf.type === "text") return { type: "text", text: buf.text ?? "" };
      let input: unknown = {};
      try {
        input = JSON.parse(buf.partialJson || "{}");
      } catch {
        input = {};
      }
      return { type: "tool_use", id: buf.id, name: buf.name, input };
    });

  return {
    id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
