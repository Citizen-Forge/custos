import type { EmbeddingConfig } from "./embeddings.js";
import { embed } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

export async function searchMemory(store: MemoryStore, embedding: EmbeddingConfig, query: string, limit = 8) {
  const vector = await embed(embedding, query);
  return store.search(vector, limit);
}
