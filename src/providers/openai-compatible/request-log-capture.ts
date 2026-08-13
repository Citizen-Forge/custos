import { logRequest, type RequestLogContext } from "../request-log.js";

/** Drains a teed copy of a streaming response's raw bytes purely for
 *  request-log.ts's capture -- never awaited by the caller serving the
 *  real response, so a slow or failed drain here can't add latency or
 *  block the actual turn. Raw SSE frames (`data: {...}\n\n`), not our
 *  already-translated Anthropic-format representation -- see
 *  request-log.ts's `response` field doc for why. */
export async function logStreamingResponse(
  stream: ReadableStream<Uint8Array>,
  provider: string,
  model: string,
  dispatchStartedAt: number,
  request: unknown,
  context: RequestLogContext,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (err) {
    text += `\n[request-log: capture error: ${(err as Error).message}]`;
  }
  logRequest({
    provider,
    model,
    durationMs: Date.now() - dispatchStartedAt,
    status: 200,
    error: null,
    request,
    response: text,
    context,
  });
}
