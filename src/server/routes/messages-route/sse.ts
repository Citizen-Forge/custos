import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Writes a mid-stream SSE error event, matching the real Anthropic
 *  streaming protocol's own error event shape. Used once headers have
 *  already committed to a 200 status, so a failure can no longer be
 *  signaled via HTTP status code. */
export function writeSseError(raw: ServerResponse, message: string): void {
  if (raw.writableEnded) return;
  raw.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message } })}\n\n`);
}

/** Pipes a Web ReadableStream into a hijacked raw response. Resolves once
 *  the stream ends, errors out, or the client disconnects -- whichever
 *  comes first -- so the caller's await doesn't hang on an abandoned
 *  connection. */
export function pipeWebStreamToRaw(stream: ReadableStream, raw: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const nodeStream = Readable.fromWeb(stream as never);
    nodeStream.pipe(raw);
    nodeStream.on("end", resolve);
    nodeStream.on("error", resolve);
    raw.on("close", resolve);
  });
}
