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
    const results = await searchMemory(store, runtime.embedding, input.prompt, 6);
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: formatContext(results),
      },
    };
  };
}
