// Streaming test harness shared by fixtures.test.ts and
// openai-translate.test.ts. Builds a fake `Response` from raw SSE
// bytes, drains a `ReadableStream<Uint8Array>` to text, parses an
// Anthropic SSE stream back into structured events, and assembles
// OpenAI chat-completions streaming chunks into SSE bytes for the
// upstream side.
//
// Only consumed by tests; no production caller. Kept outside the
// test files so the harness shape lives in one place -- when a
// third test file needs the same machinery, the import already
// exists. The suffix `-harness` and the `.ts` extension (rather
// than `.test.ts`) signal "helper, not a production provider".

export interface SSEEvent {
  event: string;
  data: unknown;
}

/** Build a fake `Response` whose body yields `sseContent` as a
 * single chunk and then closes. The result can be passed to
 * `translateStream` (which only reads `openaiRes.body`) without
 * any network I/O. */
export function makeFakeResponse(sseContent: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseContent));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Drain a `ReadableStream<Uint8Array>` to a UTF-8 string. Used on
 * the OUTPUT side after `translateStream` produces the Anthropic-
 * shaped stream. */
export async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Parse raw Anthropic SSE bytes back into structured events. Each
 * event block must contain both `event:` and `data:` lines -- the
 * OpenAI `[DONE]` terminator and Anthropic `message_stop` (data:
 * null) are filtered out so consumers see only content-bearing
 * events. */
export function parseSSEOutput(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    const event = eventLine.slice("event: ".length).trim();
    const dataRaw = dataLine.slice("data: ".length).trim();
    if (dataRaw === "[DONE]" || dataRaw === "null") continue;
    try {
      events.push({ event, data: JSON.parse(dataRaw) });
    } catch {
      // skip malformed
    }
  }
  return events;
}

/** Assemble per-chunk chat-completions JSON into a full upstream
 * SSE feed. Each chunk becomes one `data: ...\n\n` block; the
 * OpenAI `[DONE]` terminator is appended so `translateStream` can
 * finish cleanly without waiting on a dead socket. Assumes a
 * well-behaved upstream (no interleaved `event:` lines or retry
 * comments) -- the matrix exercises happy-path shapes only. */
export function chunksToSSE(chunks: Array<Record<string, unknown>>): string {
  const parts = chunks.map((c) => "data: " + JSON.stringify(c));
  parts.push("data: [DONE]");
  return parts.join("\n\n") + "\n\n";
}
