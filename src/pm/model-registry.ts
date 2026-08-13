import { JsonCollection, pmPath } from "./store.js";
import type { GatewayConfig } from "../config.js";

/**
 * What Custos knows about each provider/model combination it can send work
 * to: how it's paid for, and whether it is usable right now.
 *
 * This exists because "is this provider/model combination currently usable"
 * is not a static fact. A subscription model is free until its window is
 * exhausted and then unusable for hours; a free tier is unmetered but rate
 * limited. Without somewhere to record that, a dispatch that already knows
 * a combination is burned out would try it anyway on every tick.
 *
 * This module used to also carry a per-model "capability" rating (1-5,
 * moved by a feedback loop reading QA verdicts) that the engineering
 * manager's assignment prompt read to help pick a model for a ticket.
 * Removed: since the fallback-set redesign, an engineer/EM/etc is assigned
 * a named fallback SET (see config.ts's FallbackSetDef), never a raw
 * provider+model -- nothing has read a capability score to make a
 * dispatch decision since that migration. The rating was still being
 * computed on every QA verdict with nothing consuming it.
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
  /** Set when the provider signalled it can't serve requests -- a 429, an
   * exhausted session window, a rejected key. Null when usable. */
  unavailableUntil: number | null;
  /** Why it went unavailable, for the UI and the manager's prompt. */
  unavailableReason: string | null;
  updatedAt: number;
}

const models = new JsonCollection<ModelRecord>(pmPath("models.json"));

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
  const instance = config.openaiCompatibleInstances?.[providerKey];
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
    unavailableUntil: null,
    unavailableReason: null,
    updatedAt: Date.now(),
  });
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
