// Loads/saves data/config.json. The wire-format schema lives in
// ./config/types.ts, the out-of-the-box defaults in ./config/defaults.ts,
// and legacy-shape migration in ./config/migrate.ts -- this file re-exports
// all three so every existing `from "./config.js"` import keeps working.
import type { GatewayConfig } from "./config/types.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { migrateLegacyShape, pruneStaleFields } from "./config/migrate.js";
import { readJsonFile, writeJsonFile } from "./util/json-file.js";

export type {
  ProviderEntry,
  AnthropicConfig,
  EmbeddingProviderConfig,
  FallbackSetDef,
  FallbackProviderEntry,
  EmbeddingConfig,
  CostType,
  ModelDef,
  ProviderDef,
  GatewayConfig,
  SlackConfig,
} from "./config/types.js";

const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? "data/config.json";

async function readFileConfig(): Promise<Partial<GatewayConfig>> {
  return readJsonFile<Partial<GatewayConfig>>(CONFIG_PATH, {});
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
  // Order matters: migrate legacy entries into canonical `providers`
  // BEFORE dropping the legacy field, so the prune doesn't lose user
  // data. Both helpers are no-ops on already-canonical files so the cost
  // is negligible on every restart, not just on migration events.
  migrateLegacyShape(fileConfig);
  pruneStaleFields(fileConfig);

  // Merge the default config with the file config.
  const merged: GatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...fileConfig.anthropic },
    openaiCompatibleInstances: { ...DEFAULT_CONFIG.openaiCompatibleInstances, ...fileConfig.openaiCompatibleInstances },
    tasks: { ...DEFAULT_CONFIG.tasks, ...fileConfig.tasks },
  };

  // fileConfig.providers is populated either by user-set or by
  // migrateLegacyShape above. Defaults overlay on top.
  merged.providers = { ...DEFAULT_CONFIG.providers, ...(fileConfig.providers ?? {}) };

  // Fallback sets merge from defaults with user overrides.
  merged.fallbackSets = { ...DEFAULT_CONFIG.fallbackSets, ...(fileConfig.fallbackSets ?? {}) };

  if (!merged.anthropic?.apiKey && process.env.ANTHROPIC_API_KEY) {
    merged.anthropic = { ...merged.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }

  return merged;
}

/** Persists to data/config.json. Only ever writes what the admin UI (or a
 * hand-edited config file) explicitly set -- an env-sourced API key is
 * never written back, so removing the env var still falls back cleanly.
 * Writes the new `providers` shape; the old `openaiCompatibleInstances`
 * field is no longer persisted (loadConfig migrates it on read). */
export async function saveConfig(config: GatewayConfig): Promise<void> {
  const toPersist: Record<string, unknown> = { ...config };
  const anthropic = toPersist.anthropic as { apiKey?: string } | undefined;
  if (anthropic?.apiKey && (await getApiKeySource()) === "env" && anthropic.apiKey === process.env.ANTHROPIC_API_KEY) {
    anthropic.apiKey = undefined;
  }
  // Drop the deprecated fields -- we write the new shape going forward.
  // `clientApiKey` is the proxy-era shared secret for /v1/messages
  // client access; since the surface is now internal-only we strip it on
  // write so saving through the admin UI doesn't stomp the canonical
  // read-time prune and re-persist a stale key back to disk in any
  // install that hasn't yet restarted post-strip.
  delete toPersist.openaiCompatibleInstances;
  delete toPersist.clientApiKey;
  await writeJsonFile(CONFIG_PATH, toPersist);
}
