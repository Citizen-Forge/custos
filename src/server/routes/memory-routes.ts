import type { FastifyInstance } from "fastify";
import { searchMemory } from "../../memory/search.js";
import type { RouteDeps } from "./types.js";

export function registerMemoryRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/memory/search", async (req) => {
    const { query, limit } = req.body as { query: string; limit?: number };
    // No embeddings global agent configured: return an empty result set
    // rather than 500-ing. Memory search is a soft hint -- the surrounding
    // chat still works without it; a hard fail would block the UI from
    // showing the rest of the conversation history.
    if (!deps.runtime.embedding) return { results: [] };
    return { results: await searchMemory(deps.memoryStore, deps.runtime.embedding, query, limit) };
  });
}
