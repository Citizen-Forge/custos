// Small pure helpers used by GlobalQueue's dispatch/enqueue paths.
import type { ProviderResponse } from "../types.js";

/** Read the first 200 chars of a response body for inclusion in the
 *  activity log's error message. Tees the stream so the original body
 *  remains available for the caller. Returns the default
 *  `"HTTP ${status} from provider"` on any failure (no body, tee fails,
 *  read fails) so the queue never surfaces a blank message. */
export async function extractErrorMessage(response: ProviderResponse): Promise<string> {
  if (!response.body) return `HTTP ${response.status} from provider`;
  try {
    const [forLog, forCaller] = response.body.tee();
    response.body = forCaller;
    const reader = forLog.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // flush remaining bytes
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed) return `HTTP ${response.status} from provider`;
    return `HTTP ${response.status}: ${trimmed}`;
  } catch {
    return `HTTP ${response.status} from provider`;
  }
}

/** Mirrors the reason-extraction the queued-entry abort listener already
 *  does (see enqueue()'s onAbort) so a signal that's already aborted by
 *  the time we check it rejects with the same shape whether it's caught
 *  early (this) or aborts while genuinely waiting in the queue (onAbort). */
export function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("aborted");
}
