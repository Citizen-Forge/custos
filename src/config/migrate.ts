// Migrates a freshly-read on-disk config to canonical shape: folds the
// legacy `openaiCompatibleInstances` shape into `providers`, then strips
// every documented-deprecated field so the in-memory GatewayConfig (and,
// after the next saveConfig, the file itself) converges to the current
// schema on every restart.
import type { OpenAICompatibleInstanceConfig } from "../providers/openai-compatible.js";
import type { CostType, GatewayConfig, ProviderDef } from "./types.js";

/** Infers costType from an instance config. Metered when pricing is set,
 * free otherwise -- the old shape had no explicit subscription flag. */
function inferCostType(instance: OpenAICompatibleInstanceConfig): CostType {
  return instance.pricing ? "metered" : "free";
}

/** Migrates an old-style openaiCompatibleInstances entry to a ProviderDef.
 * Each old instance becomes a provider with one enabled model. */
function migrateInstanceToProvider(name: string, instance: OpenAICompatibleInstanceConfig): ProviderDef {
  return {
    baseUrl: instance.baseUrl,
    costType: inferCostType(instance),
    models: [{ name: instance.model, enabled: true, pricing: instance.pricing }],
    apiKey: instance.apiKey,
    maxConcurrent: instance.maxConcurrent,
    priority: instance.priority,
    emitLateMetadataDelta: instance.emitLateMetadataDelta,
    maxRequestBytes: instance.maxRequestBytes,
  };
}

/** Folds the legacy `openaiCompatibleInstances` shape into the canonical
 * `providers` shape, in-place on `fileConfig`. Runs BEFORE pruneStaleFields
 * so the prune can drop the legacy field without losing user data: legacy
 * entries that haven't been migrated to the new shape are migrated here,
 * the in-memory `fileConfig.providers` carries them through the merge,
 * and the prune then zeros the legacy field on disk-equivalent for the
 * rest of the load. */
export function migrateLegacyShape(fileConfig: Partial<GatewayConfig>): void {
  if (fileConfig.providers || !fileConfig.openaiCompatibleInstances) return;
  const migrated: Record<string, ProviderDef> = {};
  for (const [name, instance] of Object.entries(fileConfig.openaiCompatibleInstances)) {
    migrated[name] = migrateInstanceToProvider(name, instance);
  }
  fileConfig.providers = migrated;
}

/** Strips documented-deprecated fields from a freshly-read `fileConfig`
 * before the merge step so they never reach the in-memory `GatewayConfig`.
 * Today `saveConfig` already drops `openaiCompatibleInstances` on write,
 * but a file that has never been saved through the new admin UI keeps
 * that field plus any other now-defunct entries indefinitely. Pruning at
 * read means the on-disk file converges to canonical shape on every
 * restart, and a future deprecation is a one-line addition here.
 *
 * PRUNED:
 *   - `complexityRouting` — schema dropped in 5643718; no runtime caller;
 *     no admin UI mutates it. Hard drop.
 *   - `openaiCompatibleInstances` — superseded by `providers.<name>`.
 *     `migrateLegacyShape` above folds legacy entries into `providers`
 *     before this drop, so user data is preserved through the prune.
 *   - `tasks.complexityClassifier` (nested under `tasks`) — `TaskKind`
 *     no longer includes this member (dropped in this commit's type
 *     tightening), so `PUT /admin/api/tasks/complexityClassifier` now
 *     hard-400s and no admin path reaches the field. Prior on-disk
 *     entries silently phase out on the next restart; auto-pruning here
 *     lines up with the type tightening.
 *
 * KEPT (intentionally not pruned, with a documented path to future-proofing):
 *   - (none — the previous `clientApiKey` entry was a proxy-era holdover
 *     that has now been stripped alongside the client-auth gate. See
 *     `clientApiKey`'s `@deprecated` note on the GatewayConfig interface
 *     for the migration story.)
 */
export function pruneStaleFields(fileConfig: Partial<GatewayConfig>): void {
  // JSON.parse can include fields the GatewayConfig type doesn't list
  // (most commonly: previously-deprecated shapes whose schema entries
  // were dropped, e.g. complexityRouting after 5643718). Cast to a
  // record so we can still sweep those keys without TS2339.
  const stale = fileConfig as Partial<GatewayConfig> & Record<string, unknown>;
  delete stale.complexityRouting;
  delete stale.openaiCompatibleInstances;
  // Drop the legacy client-auth gate's stored key. custos is no longer a
  // Claude Code proxy, the /v1/messages + /hooks/* + /memory/search
  // surface is reachable only from custos's own spawned subprocesses,
  // and the client-auth-guard.ts stub is a no-op. Keeping the field
  // would just be a stale-secret-on-disk footgun for users who migrated
  // before the strip; pruning it at read means the file converges to
  // canonical shape on every restart, matching the same pattern
  // openaiCompatibleInstances / complexityProvider use.
  delete stale.clientApiKey;
  // Embeddings moved to a global agent (commit 2 of the global-agent
  // split). The on-disk field stopped being read by runtime after that
  // commit landed; keeping the type optional lets legacy config.json
  // files load without TS errors, but the value is dead on disk and a
  // user who wants to keep their saved embedding config should move
  // the same model/baseUrl into the embeddings global agent via the
  // admin UI's Global Services panel.
  delete stale.embeddingProvider;
  // Same approach for the nested legacy task-kind key -- `fileConfig.tasks`
  // is typed as `Record<TaskKind, …>` and `complexityClassifier` doesn't
  // exist there any more; the cast lets the sweep keep its invariant that
  // the on-disk file converges to canonical shape.
  const tasks = fileConfig.tasks as Record<string, unknown> | undefined;
  delete tasks?.complexityClassifier;
}
