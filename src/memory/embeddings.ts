export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  /** Full URL path to the embeddings endpoint. Ollama uses `/api/embeddings`
   *  (`POST {model, prompt}`); OpenAI-compat providers use `/embeddings`
   *  (`POST {model, input}`). Set by `Runtime.refreshEmbedding()` based
   *  on the provider's URL shape — the consumer hard-codes neither the
   *  path nor the body format, so the 404 that prompted this field was the
   *  old code always appending `/api/embeddings` regardless of the provider. */
  path: string;
}

export async function embed(config: EmbeddingConfig, text: string): Promise<number[]> {
  // Ollama-native path uses `/api/embeddings` with `{model, prompt}`;
  // OpenAI-compat uses `/embeddings` with `{model, input}`. The path
  // field encodes which shape, so the body format follows from it.
  const isOllama = config.path === "/api/embeddings";
  const body = isOllama
    ? JSON.stringify({ model: config.model, prompt: text })
    : JSON.stringify({ model: config.model, input: text });
  const res = await fetch(`${config.baseUrl}${config.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}
