import type { MemoryStore } from "./store.js";
import type { EmbeddingConfig } from "./embeddings.js";
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
// so it has nothing to search against yet).
export function createUserPromptSubmitHandler(store: MemoryStore, embedding: EmbeddingConfig) {
  return async function handle(input: UserPromptSubmitInput) {
    const results = await searchMemory(store, embedding, input.prompt, 6);
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: formatContext(results),
      },
    };
  };
}
