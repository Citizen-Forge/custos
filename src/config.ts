import { readFile } from "node:fs/promises";
import type { TaskKind } from "./types.js";

export interface ProviderEntry {
  provider: "anthropic" | "ollama";
  priority: number;
}

export interface GatewayConfig {
  anthropic?: { apiKey?: string };
  ollama?: { baseUrl: string; model: string };
  tasks: Record<TaskKind, ProviderEntry[]>;
}

const DEFAULT_CONFIG: GatewayConfig = {
  ollama: { baseUrl: "http://192.168.250.219:11434", model: "qwen2.5:14b-instruct-q4_K_M" },
  tasks: {
    general: [
      { provider: "anthropic", priority: 1 },
      { provider: "ollama", priority: 2 },
    ],
    permissionClassifier: [
      { provider: "ollama", priority: 1 },
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
    ollama: { ...DEFAULT_CONFIG.ollama, ...fileConfig.ollama } as GatewayConfig["ollama"],
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
  };

  if (process.env.ANTHROPIC_API_KEY) {
    merged.anthropic = { ...merged.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }

  return merged;
}
