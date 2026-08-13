// Small pure helpers used by GlobalQueue's dispatch/enqueue paths.
import type { ProviderResponse } from "../types.js";

/** Re-exported for backward compat -- the actual definition lives in
 *  ../abort-utils.ts, shared with ThrottledProvider's identical need. */
export { abortErrorFromSignal } from "../abort-utils.js";

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

