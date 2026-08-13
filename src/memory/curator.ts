// Periodic background job that keeps long-lived session context usable:
// compact.ts rewrites session files that have grown past a provider's
// request-size cap, and extract-facts.ts pulls durable facts out of new
// exchanges into the memory store. The actual logic lives under
// ./curator/, split by concern; this file re-exports the public surface
// so every existing `from "./curator.js"` import keeps working, plus the
// scheduler entry point that ties the two passes together.
export type { CuratorDeps } from "./curator/shared.js";
export { extractJsonArray } from "./curator/shared.js";
export { extractContentText } from "./curator/text-extraction.js";
export { runCuratorPass } from "./curator/extract-facts.js";
export { runCompactPass } from "./curator/compact.js";

import type { CuratorDeps } from "./curator/shared.js";
import { runCuratorPass } from "./curator/extract-facts.js";
import { runCompactPass } from "./curator/compact.js";

/** Takes a deps thunk rather than a fixed object so a live config reload
 * (e.g. from the admin UI) is picked up on the next tick instead of
 * requiring a restart. The thunk may resolve to `embedding: null` when
 * no embeddings global agent has been configured -- the curator still
 * runs (so its presence is obvious in logs) but skips fact storage
 * rather than crashing. Runs compact pass first (to keep session files
 * under the size threshold) then the curator pass (to extract facts from
 * any new exchanges). Both errors are caught independently so a failure
 * in one does not strand the other. */
export function startCurator(getDeps: () => CuratorDeps, intervalMs: number): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await runCompactPass(getDeps());
    } catch (err) {
      console.error("compact pass failed:", err);
    }
    try {
      await runCuratorPass(getDeps());
    } catch (err) {
      console.error("curator pass failed:", err);
    }
  }, intervalMs);
}
