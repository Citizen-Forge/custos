export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
}

export async function embed(config: EmbeddingConfig, text: string): Promise<number[]> {
  const res = await fetch(`${config.baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}
