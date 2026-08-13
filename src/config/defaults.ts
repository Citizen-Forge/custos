// The out-of-the-box config a fresh instance boots with, before any
// admin-UI edit ever touches data/config.json.
import type { GatewayConfig } from "./types.js";

const OLLAMA_HOST = "http://localhost:11434";

export const DEFAULT_CONFIG: GatewayConfig = {
  providers: {
    ollama: {
      baseUrl: `${OLLAMA_HOST}/v1`,
      costType: "free",
      models: [{ name: "qwen2.5:14b-instruct-q4_K_M", enabled: true }],
      maxConcurrent: 1,
      // Ollama on consumer hardware recovers from a saturated request
      // queue in a few seconds. The 60s global default is overkill
      // for a transient; 30s keeps the gateway responsive without
      // hammering a still-recovering local model.
      cooldownFallbackMs: 30_000,
    },
    "ollama-fast": {
      baseUrl: `${OLLAMA_HOST}/v1`,
      costType: "free",
      models: [{ name: "qwen2.5:3b-instruct", enabled: true }],
      maxConcurrent: 1,
      cooldownFallbackMs: 30_000,
    },
  },
  openaiCompatibleInstances: {},
  fallbackSets: {
    "complex": {
      name: "Complex reasoning",
      description: "Best for complex decision-making, abstract reasoning, and high-stakes work where quality matters more than speed",
      providers: [{ provider: "anthropic", model: "claude-sonnet-5" }, { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" }],
    },
    "standard": {
      name: "Standard work",
      description: "Everyday development tasks and routine work where a capable but cost-effective model is appropriate",
      providers: [{ provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" }],
    },
    "fast": {
      name: "Fast / light",
      description: "Quick turnarounds, simple tickets, classification, and other latency-sensitive work where correctness but not depth is needed",
      providers: [{ provider: "ollama-fast", model: "qwen2.5:3b-instruct" }, { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" }],
    },
    // Dedicated fallback set for the global embeddings service. Distinct
    // from "standard" because embeddings need an embedding-capable model
    // (nomic-embed-text on Ollama), not a chat model — Ollama's
    // /api/embeddings endpoint will reject chat-model names. The
    // embeddings global agent defaults to this set; operators on a
    // different embedding provider can override via the Global Services
    // panel.
    //
    // The default provider at http://localhost:11434/v1 is reachable when
    // Ollama runs on the same Docker host as the gateway (the container's
    // localhost resolves to the host when using --network host). When
    // Ollama runs on a separate machine (the canonical remote-Ollama
    // scenario), operators must either change the "ollama" provider's
    // baseUrl to the reachable host, or reassign the embeddings global
    // agent's fallbackSet to a provider that points at that host.
    "embeddings": {
      name: "Embeddings",
      description: "Vector embeddings for the memory store. Uses Ollama's native embedding endpoint, which requires an embedding-capable model (nomic-embed-text, mxbai-embed-large). Do not point this set at a chat model.",
      providers: [{ provider: "ollama", model: "nomic-embed-text" }],
    },
    // Dedicated fallback set for the global permission classifier.
    // Distinct from "fast" because the classifier sits on every tool
    // call (very high call volume) and benefits from a smaller model
    // than "fast"'s default. Ollama's 3b-instruct is the lowest-cost
    // option that follows the JSON-only contract reliably.
    "classifier": {
      name: "Permission classifier",
      description: "Gates every tool call from autonomous agents. Should be a small, fast model that follows the JSON-only contract reliably.",
      providers: [{ provider: "ollama-fast", model: "qwen2.5:3b-instruct" }],
    },
  },
  tasks: {
    general: [
      { provider: "anthropic", priority: 1 },
      { provider: "ollama", priority: 2 },
    ],
    permissionClassifier: [
      { provider: "ollama-fast", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
    memoryCurator: [
      { provider: "ollama", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
  },
};
