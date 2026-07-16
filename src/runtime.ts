import { AnthropicProvider } from "./providers/anthropic.js";
import { OllamaProvider } from "./providers/ollama.js";
import { ProviderRouter } from "./providers/router.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { EmbeddingConfig } from "./memory/embeddings.js";

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";

/**
 * Holds the currently-active config-derived objects (providers, router,
 * embedding target) and rebuilds them on demand. Routes and the curator
 * read through this rather than capturing router/embedding once at
 * startup, so an admin-UI config change takes effect on the next request
 * instead of requiring a container restart.
 */
export class Runtime {
  config!: GatewayConfig;
  router!: ProviderRouter;
  embedding!: EmbeddingConfig;

  async reload(): Promise<void> {
    const config = await loadConfig();

    const providers: Record<string, Provider> = {
      anthropic: new AnthropicProvider({ apiKey: config.anthropic?.apiKey }),
    };
    for (const [name, instance] of Object.entries(config.ollamaInstances)) {
      providers[name] = new OllamaProvider(instance);
    }

    const primaryOllama = config.ollamaInstances.ollama ?? Object.values(config.ollamaInstances)[0];

    this.config = config;
    this.router = new ProviderRouter(providers, config);
    this.embedding = { baseUrl: primaryOllama?.baseUrl ?? "http://localhost:11434", model: EMBEDDING_MODEL };
  }
}
