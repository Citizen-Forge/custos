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

/** Word-set Jaccard similarity, in [0, 1]. The same "how much do these two
 *  strings actually overlap" measure used to collapse duplicate ticket
 *  comments (see pm/context.ts) -- reused here because it turned out to be
 *  the more reliable near-duplicate signal for this store too. */
function wordJaccardSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wa.size === 0 || wb.size === 0) return 0;
  let intersection = 0;
  for (const w of wa) if (wb.has(w)) intersection++;
  return intersection / (wa.size + wb.size - intersection);
}

/** How much of a candidate's words have to overlap the new fact's words
 *  before it counts as "already known" rather than new information.
 *  Calibrated against real data from a 6,400-fact store where cosine
 *  similarity on this embedding model (nomic-embed-text) turned out not to
 *  separate true near-duplicates from unrelated facts reliably -- a
 *  confirmed duplicate pair scored 0.93 while a completely unrelated fact
 *  scored 0.91, so a bare vector-similarity threshold would have both
 *  missed real duplicates and silently dropped new information. Word
 *  overlap on the actual fact text is the more trustworthy signal for
 *  this store's failure mode specifically: the same fact restated with
 *  minor wording changes, not a paraphrase in genuinely different words. */
const NEAR_DUPLICATE_TEXT_THRESHOLD = 0.55;

/** How many nearest neighbors (by vector similarity) to pull as candidates
 *  before checking them for a real text-level near-duplicate. Wide enough
 *  to catch a true duplicate even when the embedding model ranks it a few
 *  places below an unrelated-but-higher-scoring fact (see the threshold
 *  doc comment above), narrow enough to keep the check cheap. */
const NEAR_DUPLICATE_CANDIDATE_LIMIT = 10;

/** True when `text` restates something already in the store closely
 *  enough that storing it again would just be noise -- see
 *  NEAR_DUPLICATE_TEXT_THRESHOLD's doc comment for why this checks word
 *  overlap on the candidates rather than trusting the vector score alone.
 *  `vector` is the already-computed embedding for `text` (the caller needs
 *  it for the store write either way, so this avoids embedding twice). */
export async function isNearDuplicateFact(store: MemoryStore, vector: number[], text: string): Promise<boolean> {
  const candidates = await store.search(vector, NEAR_DUPLICATE_CANDIDATE_LIMIT);
  return candidates.some((c) => wordJaccardSimilarity(text, c.text) >= NEAR_DUPLICATE_TEXT_THRESHOLD);
}
