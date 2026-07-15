import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OllamaProvider } from "./providers/ollama.js";
import { ProviderRouter } from "./providers/router.js";
import { registerRoutes } from "./server/routes.js";
import { MemoryStore } from "./memory/store.js";
import { startCurator } from "./memory/curator.js";

const PORT = Number(process.env.PORT ?? 8787);
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const EMBEDDING_VECTOR_SIZE = Number(process.env.EMBEDDING_VECTOR_SIZE ?? 768);
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const CURATOR_INTERVAL_MS = Number(process.env.CURATOR_INTERVAL_MS ?? 15 * 60_000);

async function main() {
  const config = await loadConfig();

  const providers: Record<string, import("./providers/types.js").Provider> = {
    anthropic: new AnthropicProvider({ apiKey: config.anthropic?.apiKey }),
  };
  if (config.ollama) {
    providers.ollama = new OllamaProvider(config.ollama);
  }

  const router = new ProviderRouter(providers, config);
  const memoryStore = new MemoryStore(QDRANT_URL, EMBEDDING_VECTOR_SIZE);
  const embedding = { baseUrl: config.ollama?.baseUrl ?? "http://localhost:11434", model: EMBEDDING_MODEL };

  startCurator({ router, store: memoryStore, embedding }, CURATOR_INTERVAL_MS);

  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  registerRoutes(app, { router, memoryStore, embedding });

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("claude-gateway failed to start:", err);
  process.exit(1);
});
