import type { EmbeddingConfig } from "./embeddings.js";
import { embed } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

/** Max chars sent to the embedding model. Most embedding models have a hard
 *  token limit (nomic-embed-text caps at 8 192 tokens ≈ ~32 000 chars).
 *  Truncating to 8 000 chars keeps the vector faithful enough for semantic
 *  search while fitting well within the model's context window. The query
 *  is the user's full prompt text which can easily exceed this when a
 *  conversation has accumulated error messages and tool results. */
const MAX_EMBED_CHARS = 8_000;

export async function searchMemory(store: MemoryStore, embedding: EmbeddingConfig, query: string, limit = 8) {
  const truncated = query.length > MAX_EMBED_CHARS ? query.slice(0, MAX_EMBED_CHARS) : query;
  const vector = await embed(embedding, truncated);
  return store.search(vector, limit);
}
