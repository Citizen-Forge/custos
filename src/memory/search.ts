import type { EmbeddingConfig } from "./embeddings.js";
import { embed } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

/** Max chars sent to the embedding model. The user's local Ollama runs
 *  nomic-embed-text which has a hard 2 048 token limit (~8 KB of plain
 *  text but can be much less for code-heavy or symbol-dense content).
 *  Truncating to 2 000 chars (~500-1 000 tokens) keeps the vector faithful
 *  enough for semantic search while fitting well within the model's context
 *  window. The query is the user's full prompt text which can easily exceed
 *  this when a conversation has accumulated error messages and tool
 *  results. */
const MAX_EMBED_CHARS = 2_000;

export async function searchMemory(store: MemoryStore, embedding: EmbeddingConfig, query: string, limit = 8) {
  const truncated = query.length > MAX_EMBED_CHARS ? query.slice(0, MAX_EMBED_CHARS) : query;
  const vector = await embed(embedding, truncated);
  return store.search(vector, limit);
}
