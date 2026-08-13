// The engineering manager's menu of dispatchable provider/model
// combinations. Pure -- derived live from gateway config, no I/O.
import type { GatewayConfig } from "../../config.js";

/** Provider/model combinations the engineering manager can pick from,
 * described in the terms it actually decides on: what it costs, whether
 * it's effectively free, and whether it's rate limited. Derived live from
 * gateway config so adding a provider in the admin UI immediately widens
 * the EM's menu without touching any agent record. */
export interface ProviderOption {
  providerKey: string;
  model: string;
  free: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  budgetUsd: number | null;
}

export function listProviderOptions(config: GatewayConfig): ProviderOption[] {
  const options: ProviderOption[] = [];
  // Anthropic is always offered: Custos authenticates it with the OAuth
  // subscription when no API key is set, so it carries no per-token cost
  // against the project budget and is what the EM should reach for on hard
  // tickets. Marked free for exactly that reason -- "free" here means "does
  // not draw down this project's metered spend," not "costs nobody money."
  const anthropicFree = !config.anthropic?.apiKey;
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
    options.push({ providerKey: "anthropic", model, free: anthropicFree, inputPerMTok: null, outputPerMTok: null, budgetUsd: null });
  }
  // Prefer the new providers shape with its model list.
  if (config.providers) {
    for (const [key, def] of Object.entries(config.providers)) {
      for (const modelDef of def.models) {
        if (!modelDef.enabled) continue;
        const pricing = modelDef.pricing;
        options.push({
          providerKey: key,
          model: modelDef.name,
          free: !pricing,
          inputPerMTok: pricing?.inputPerMillion ?? null,
          outputPerMTok: pricing?.outputPerMillion ?? null,
          budgetUsd: null, // Budget is now project-level, not provider-level.
        });
      }
    }
  }
  // Also read from the deprecated shape for backward compat.
  for (const [key, instance] of Object.entries(config.openaiCompatibleInstances ?? {})) {
    // Skip if already covered by the new providers shape (dedup by name).
    if (options.some((o) => o.providerKey === key)) continue;
    options.push({
      providerKey: key,
      model: instance.model,
      free: !instance.pricing,
      inputPerMTok: instance.pricing?.inputPerMillion ?? null,
      outputPerMTok: instance.pricing?.outputPerMillion ?? null,
      budgetUsd: null,
    });
  }
  return options;
}
