import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskKind, ComplexityTier } from "./types.js";
import type { OpenAICompatibleInstanceConfig } from "./providers/openai-compatible.js";

export interface ProviderEntry {
  /** References either "anthropic" or a key in `openaiCompatibleInstances`. */
  provider: string;
  priority: number;
}

export interface EmbeddingProviderConfig {
  /** Ollama's *native* API root (no "/v1" suffix) -- embeddings use
   * Ollama's own /api/embeddings, not the OpenAI-compat chat path, so
   * this is intentionally separate from any openaiCompatibleInstances
   * entry even when it happens to point at the same server. */
  baseUrl: string;
  model: string;
}

export interface ComplexityRoutingConfig {
  /** Off by default -- adds a classifier round-trip before every fresh
   * human turn and can change which model handles a conversation
   * mid-stream, so it's opt-in rather than a surprise behavior change. */
  enabled: boolean;
  tiers: Record<ComplexityTier, ProviderEntry[]>;
}

export interface GatewayConfig {
  anthropic?: { apiKey?: string };
  /** Named instances of any OpenAI-chat-completions-compatible provider --
   * Ollama, OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter, etc.
   * Named (not typed by brand) so different tasks can use different
   * models/providers, e.g. a small fast one for permission classification
   * and a bigger one for general use. */
  openaiCompatibleInstances: Record<string, OpenAICompatibleInstanceConfig>;
  embeddingProvider: EmbeddingProviderConfig;
  tasks: Record<TaskKind, ProviderEntry[]>;
  complexityRouting: ComplexityRoutingConfig;
  /** Shared secret Claude Code sends back as `x-api-key` (the same header
   * it already sends for real Anthropic API-key auth -- Custos ignores the
   * value for upstream purposes since it does its own provider auth
   * server-side, so this repurposes it as Custos's own access control).
   * Gates /v1/messages, /hooks/*, and /memory/search -- the client-facing
   * proxy surface, as opposed to the /admin and /remote paths, which use
   * the session login instead. Fails closed: unset means every request on
   * that surface is rejected, not allowed through -- there's no supported
   * "open" mode. Generate one from the admin UI's Security panel. */
  clientApiKey?: string;
}

const OLLAMA_HOST = "http://localhost:11434";
const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? "data/config.json";

const DEFAULT_CONFIG: GatewayConfig = {
  openaiCompatibleInstances: {
    ollama: { baseUrl: `${OLLAMA_HOST}/v1`, model: "qwen2.5:14b-instruct-q4_K_M" },
    "ollama-fast": { baseUrl: `${OLLAMA_HOST}/v1`, model: "qwen2.5:3b-instruct" },
  },
  embeddingProvider: { baseUrl: OLLAMA_HOST, model: "nomic-embed-text" },
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
    complexityClassifier: [
      { provider: "ollama-fast", priority: 1 },
      { provider: "anthropic", priority: 2 },
    ],
  },
  complexityRouting: {
    enabled: false,
    tiers: {
      low: [
        { provider: "ollama-fast", priority: 1 },
        { provider: "anthropic", priority: 2 },
      ],
      medium: [
        { provider: "ollama", priority: 1 },
        { provider: "anthropic", priority: 2 },
      ],
      high: [
        { provider: "anthropic", priority: 1 },
        { provider: "ollama", priority: 2 },
      ],
    },
  },
};

async function readFileConfig(): Promise<Partial<GatewayConfig>> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** File-configured API key (settable via the admin UI) wins once it
 * exists; the env var is only a bootstrap default before that happens. */
export async function getApiKeySource(): Promise<"file" | "env" | "none"> {
  const fileConfig = await readFileConfig();
  if (fileConfig.anthropic?.apiKey) return "file";
  if (process.env.ANTHROPIC_API_KEY) return "env";
  return "none";
}

export async function loadConfig(): Promise<GatewayConfig> {
  const fileConfig = await readFileConfig();

  const merged: GatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...fileConfig.anthropic },
    openaiCompatibleInstances: { ...DEFAULT_CONFIG.openaiCompatibleInstances, ...fileConfig.openaiCompatibleInstances },
    embeddingProvider: { ...DEFAULT_CONFIG.embeddingProvider, ...fileConfig.embeddingProvider },
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
    complexityRouting: {
      ...DEFAULT_CONFIG.complexityRouting,
      ...fileConfig.complexityRouting,
      tiers: { ...DEFAULT_CONFIG.complexityRouting.tiers, ...fileConfig.complexityRouting?.tiers },
    },
  };

  if (!merged.anthropic?.apiKey && process.env.ANTHROPIC_API_KEY) {
    merged.anthropic = { ...merged.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }

  return merged;
}

/** Persists to data/config.json. Only ever writes what the admin UI (or a
 * hand-edited config file) explicitly set -- an env-sourced API key is
 * never written back, so removing the env var still falls back cleanly. */
export async function saveConfig(config: GatewayConfig): Promise<void> {
  const toPersist: GatewayConfig = { ...config };
  if (toPersist.anthropic?.apiKey && (await getApiKeySource()) === "env" && toPersist.anthropic.apiKey === process.env.ANTHROPIC_API_KEY) {
    // Unchanged from the env-sourced value -- don't persist it as if the
    // admin had explicitly set it via the file/UI.
    toPersist.anthropic = { ...toPersist.anthropic, apiKey: undefined };
  }
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(toPersist, null, 2), "utf8");
}
