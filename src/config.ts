import { readFile } from "node:fs/promises";
import type { TaskKind } from "./types.js";

export interface ProviderEntry {
  /** References either "anthropic" or a key in `ollamaInstances`. */
  provider: string;
  priority: number;
}

export interface OllamaInstanceConfig {
  baseUrl: string;
  model: string;
}

export interface GatewayConfig {
  anthropic?: { apiKey?: string };
  /** Named Ollama model instances so different tasks can use different
   * models (e.g. a small fast one for permission classification, a bigger
   * one for general use) while sharing the same underlying server. */
  ollamaInstances: Record<string, OllamaInstanceConfig>;
  tasks: Record<TaskKind, ProviderEntry[]>;
}

const OLLAMA_HOST = "http://192.168.250.219:11434";

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
  },
};

export async function loadConfig(path = process.env.GATEWAY_CONFIG_PATH ?? "data/config.json"): Promise<GatewayConfig> {
  let fileConfig: Partial<GatewayConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const merged: GatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...fileConfig.anthropic },
    ollamaInstances: { ...DEFAULT_CONFIG.ollamaInstances, ...fileConfig.ollamaInstances },
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
  };

  if (process.env.ANTHROPIC_API_KEY) {
    merged.anthropic = { ...merged.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }

  return merged;
}
