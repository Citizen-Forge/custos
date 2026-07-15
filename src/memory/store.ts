import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";

export interface MemoryFact {
  text: string;
  topic: string;
  sourceSessionId: string;
  createdAt: string;
}

const COLLECTION = "memory_facts";

export class MemoryStore {
  private readonly client: QdrantClient;
  private ready = false;

  constructor(
    url: string,
    private readonly vectorSize: number,
  ) {
    this.client = new QdrantClient({ url });
  }

  private async ensureCollection(): Promise<void> {
    if (this.ready) return;
    const collections = await this.client.getCollections();
    if (!collections.collections.some((c) => c.name === COLLECTION)) {
      await this.client.createCollection(COLLECTION, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
    }
    this.ready = true;
  }

  async upsert(fact: MemoryFact, vector: number[]): Promise<void> {
    await this.ensureCollection();
    await this.client.upsert(COLLECTION, {
      points: [{ id: randomUUID(), vector, payload: { ...fact } }],
    });
  }

  async search(vector: number[], limit = 8): Promise<(MemoryFact & { score: number })[]> {
    await this.ensureCollection();
    const results = await this.client.search(COLLECTION, { vector, limit });
    return results.map((r) => ({ ...(r.payload as unknown as MemoryFact), score: r.score }));
  }
}
