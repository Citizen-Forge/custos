import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskKind, ComplexityTier } from "./types.js";

export interface ProviderEntry {
  /** References either "anthropic" or a key in `ollamaInstances`. */
  provider: string;
  priority: number;
}

export interface OllamaInstanceConfig {
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
  /** Named Ollama model instances so different tasks can use different
   * models (e.g. a small fast one for permission classification, a bigger
   * one for general use) while sharing the same underlying server. */
  ollamaInstances: Record<string, OllamaInstanceConfig>;
  tasks: Record<TaskKind, ProviderEntry[]>;
  complexityRouting: ComplexityRoutingConfig;
}

const OLLAMA_HOST = "http://192.168.250.219:11434";
const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? "data/config.json";

const DEFAULT_CONFIG: GatewayConfig = {
  ollamaInstances: {
    ollama: { baseUrl: OLLAMA_HOST, model: "qwen2.5:14b-instruct-q4_K_M" },
    "ollama-fast": { baseUrl: OLLAMA_HOST, model: "qwen2.5:3b-instruct" },
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
    ollamaInstances: { ...DEFAULT_CONFIG.ollamaInstances, ...fileConfig.ollamaInstances },
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
