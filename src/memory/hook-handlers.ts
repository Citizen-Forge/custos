import type { MemoryStore } from "./store.js";
import type { Runtime } from "../runtime.js";
import { searchMemory } from "./search.js";

function formatContext(results: { topic: string; text: string; score: number }[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r) => `- [${r.topic}] ${r.text}`).join("\n");
  return `Relevant memory from past sessions:\n${lines}`;
}

export interface UserPromptSubmitInput {
  session_id: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

/** In-memory dedup cache for concurrent embedding searches. When a batch
 *  of agent messages fires 5 user-prompt-submit hooks at once (common
 *  during tool-call bursts), only the first unique session_id+prompt
 *  combination actually calls searchMemory; the other 4 await the same
 *  Promise and reuse the result. The entry evicts itself 2 seconds after
 *  insertion so a genuinely new prompt always generates fresh context.
 *  Shrink-wrapped into a module-level closure so the handler closure
 *  doesn't re-create it on every registration. */
const searchCache = new Map<string, Promise<Awaited<ReturnType<typeof searchMemory>>>>();
const SEARCH_CACHE_TTL_MS = 2_000;

// Handles both "new session" and "new topic" injection: UserPromptSubmit
// fires on every prompt, including a session's first one, so a separate
// SessionStart hook would be redundant (it fires before any prompt exists,
// so it has nothing to search against yet). If no embeddings global agent
// is configured the handler still answers (the hook protocol requires a
// response shape) but with empty context, so a missing embedding model
// shows up as "no relevant memory" rather than a 500.
export function createUserPromptSubmitHandler(store: MemoryStore, runtime: Runtime) {
  return async function handle(input: UserPromptSubmitInput) {
    if (!runtime.embedding) {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: "",
        },
      };
    }

    // Dedup: if another request for the same session + prompt is already
    // in-flight, wait for its result instead of firing a duplicate
    // embedding fetch. An agent batch can deliver a dozen prompt tokens
    // in rapid succession; each one would otherwise trigger a full
    // embedding + vector search round-trip for the same query text.
    const cacheKey = `${input.session_id}::${input.prompt}`;
    const pending = searchCache.get(cacheKey);
    if (pending) {
      const results = await pending;
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: formatContext(results),
        },
      };
    }

    const promise = searchMemory(store, runtime.embedding, input.prompt, 6);
    searchCache.set(cacheKey, promise);
    // Evict after TTL — by then any concurrent batch has finished and a
    // fresh prompt from the same session deserves its own embedding.
    // Uses the identity check (`searchCache.get(cacheKey) === promise`)
    // so that a fast subsequent request for the same key (within TTL but
    // after the first promise resolved and was already evicted by a
    // previous timer) doesn't accidentally delete a newer entry.
    const timer = setTimeout(() => {
      if (searchCache.get(cacheKey) === promise) searchCache.delete(cacheKey);
    }, SEARCH_CACHE_TTL_MS);
    // Unref so the timer doesn't keep the process alive just for a cache
    // eviction — Fastify keeps the loop busy while listening.
    timer.unref();

    try {
      const results = await promise;
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: formatContext(results),
        },
      };
    } finally {
      // Defensive: if the promise rejected, remove the cache entry so
      // subsequent requests retry rather than all getting the same stale
      // rejection. The identity check guards against a racing timer
      // having already replaced the entry with a fresh promise.
      if (searchCache.get(cacheKey) === promise) searchCache.delete(cacheKey);
      clearTimeout(timer);
    }
  };
}
