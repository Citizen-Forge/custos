import { JsonCollection, pmPath } from "./store.js";
import type { GatewayConfig } from "../config.js";

/**
 * What Custos knows about each provider/model combination it can send work
 * to: how it's paid for, how good it has proved to be, and whether it is
 * usable right now.
 *
 * This exists because "which model should do this ticket" is not a static
 * choice. A subscription model is free until its window is exhausted and
 * then unusable for hours; a free tier is unmetered but rate limited; a
 * local model never runs out but can only do simple work. Without somewhere
 * to record that, the engineering manager pins every ticket to the best
 * model it knows and the whole pipeline stops the moment that one runs out.
 */

/** How using this combination is paid for -- the axis that decides what
 * "unavailable" means and what running out looks like. */
export type Billing =
  /** Covered by a flat subscription with a usage window (Anthropic's 5-hour
   * session limit). Costs nothing per token, but goes hard-unavailable when
   * the window is exhausted and comes back on a known reset. */
  | "subscription"
  /** Billed per token. Always available until the budget says otherwise. */
  | "metered"
  /** Free tier or self-hosted. No cost, but usually rate limited or slow. */
  | "free";

export interface ModelRecord {
  /** `${providerKey}/${model}` */
  id: string;
  providerKey: string;
  model: string;
  billing: Billing;
  /** 1–5, how much this combination can be trusted with. Seeded from the
   * provider's own tier and then moved by results — see recordOutcome. */
  capability: number;
  /** Completed tickets and QA bounces, the evidence behind `capability`. */
  completed: number;
  qaFailures: number;
  /** Set when the provider signalled it can't serve requests -- a 429, an
   * exhausted session window, a rejected key. Null when usable. */
  unavailableUntil: number | null;
  /** Why it went unavailable, for the UI and the manager's prompt. */
  unavailableReason: string | null;
  /** Requests per hour this provider tolerates, if known. */
  requestsPerHour: number | null;
  updatedAt: number;
}

const models = new JsonCollection<ModelRecord>(pmPath("models.json"));

/** Where a combination starts before it has any track record. Deliberately
 * conservative for local models: they're the fallback of last resort and
 * should earn their way up rather than being trusted by default. */
const SEED_CAPABILITY: Record<string, number> = {
  "claude-opus-5": 5,
  "claude-sonnet-5": 4,
  "claude-haiku-4-5-20251001": 3,
};
const DEFAULT_SEED = 2;

export function modelId(providerKey: string, model: string): string {
  return `${providerKey}/${model}`;
}

/** Classifies a configured provider. Anthropic without an API key is served
 * by the OAuth subscription; with one it's billed per token. */
export function classifyBilling(providerKey: string, config: GatewayConfig): Billing {
  if (providerKey === "anthropic") return config.anthropic?.apiKey ? "metered" : "subscription";
  // Prefer the new providers shape, fall back to deprecated.
  const def = config.providers?.[providerKey];
  if (def) return def.costType === "metered" ? "metered" : def.costType === "subscription" ? "subscription" : "free";
  const instance = config.openaiCompatibleInstances[providerKey];
  return instance?.pricing ? "metered" : "free";
}

export async function ensureModel(providerKey: string, model: string, config: GatewayConfig): Promise<ModelRecord> {
  const id = modelId(providerKey, model);
  const existing = await models.get(id);
  if (existing) return existing;
  return models.insert({
    id,
    providerKey,
    model,
    billing: classifyBilling(providerKey, config),
    capability: SEED_CAPABILITY[model] ?? DEFAULT_SEED,
    completed: 0,
    qaFailures: 0,
    unavailableUntil: null,
    unavailableReason: null,
    requestsPerHour: null,
    updatedAt: Date.now(),
  });
}

export async function listModels(): Promise<ModelRecord[]> {
  return (await models.list()).sort((a, b) => b.capability - a.capability || a.id.localeCompare(b.id));
}

export function isAvailable(record: ModelRecord): boolean {
  return record.unavailableUntil === null || Date.now() >= record.unavailableUntil;
}

/**
 * Marks a combination as unusable for a while. Called when a provider tells
 * us so — a 429, an exhausted subscription window — rather than guessed,
 * which is why the reset time comes from the provider's own headers where
 * it gives one.
 */
export async function markUnavailable(providerKey: string, model: string, forMs: number, reason: string): Promise<void> {
  const id = modelId(providerKey, model);
  await models.update(id, (record) => {
    record.unavailableUntil = Date.now() + forMs;
    record.unavailableReason = reason;
    record.updatedAt = Date.now();
  });
}

/** Clears a cooldown early -- used when a request against it succeeds, since
 * that's proof the window reopened sooner than advertised. */
export async function markAvailable(providerKey: string, model: string): Promise<void> {
  const id = modelId(providerKey, model);
  await models.update(id, (record) => {
    if (record.unavailableUntil === null) return;
    record.unavailableUntil = null;
    record.unavailableReason = null;
    record.updatedAt = Date.now();
  });
}

/**
 * The capability feedback loop. QA's verdict is the only honest signal about
 * whether a model was up to the work it was given, so it's what moves the
 * rating: sustained bounces pull a model down, a clean run nudges it up.
 *
 * Movement is deliberately asymmetric and slow. A single bad ticket can be
 * the ticket's fault rather than the model's, but a model that keeps failing
 * should stop being chosen quickly -- so failures move it twice as far as
 * successes, and only after enough evidence to not be noise.
 */
export async function recordOutcome(providerKey: string, model: string, outcome: "passed" | "bounced"): Promise<ModelRecord | null> {
  const id = modelId(providerKey, model);
  return models.update(id, (record) => {
    if (outcome === "passed") record.completed += 1;
    else record.qaFailures += 1;

    const samples = record.completed + record.qaFailures;
    if (samples >= 3) {
      const failureRate = record.qaFailures / samples;
      if (failureRate > 0.5) record.capability = Math.max(1, record.capability - 0.5);
      else if (failureRate < 0.2 && record.completed >= 3) record.capability = Math.min(5, record.capability + 0.25);
    }
    record.updatedAt = Date.now();
  });
}

/**
 * Provider-level availability. A rate limit or an exhausted subscription
 * window is a property of the account, not of one model name -- Anthropic's
 * 5-hour limit is unified across models -- so it applies to every record
 * belonging to that provider.
 */
export async function markProviderUnavailable(providerKey: string, forMs: number, reason: string): Promise<void> {
  const until = Date.now() + forMs;
  for (const record of await models.find((row) => row.providerKey === providerKey)) {
    await models.update(record.id, (row) => {
      // Never shorten an existing cooldown: a later, vaguer signal shouldn't
      // undo a precise reset time the provider already gave us.
      if (row.unavailableUntil !== null && row.unavailableUntil > until) return;
      row.unavailableUntil = until;
      row.unavailableReason = reason;
      row.updatedAt = Date.now();
    });
  }
}

export async function markProviderAvailable(providerKey: string): Promise<void> {
  for (const record of await models.find((row) => row.providerKey === providerKey && row.unavailableUntil !== null)) {
    await models.update(record.id, (row) => {
      row.unavailableUntil = null;
      row.unavailableReason = null;
      row.updatedAt = Date.now();
    });
  }
}

export async function setCapability(providerKey: string, model: string, capability: number): Promise<ModelRecord | null> {
  return models.update(modelId(providerKey, model), (record) => {
    record.capability = Math.max(1, Math.min(5, capability));
    record.updatedAt = Date.now();
  });
}

/** Seeds a record for every combination the gateway can currently reach, so
 * the manager's menu reflects configuration rather than only what has
 * happened to run before. */
export async function syncFromConfig(config: GatewayConfig, anthropicModels: string[]): Promise<ModelRecord[]> {
  for (const model of anthropicModels) await ensureModel("anthropic", model, config);
  // Prefer the new providers shape with its model list.
  if (config.providers) {
    for (const [key, def] of Object.entries(config.providers)) {
      for (const modelDef of def.models) {
        if (modelDef.enabled) await ensureModel(key, modelDef.name, config);
      }
    }
  } else {
    // Fall back to deprecated openaiCompatibleInstances.
    for (const [key, instance] of Object.entries(config.openaiCompatibleInstances)) {
      await ensureModel(key, instance.model, config);
    }
  }
  return listModels();
}
