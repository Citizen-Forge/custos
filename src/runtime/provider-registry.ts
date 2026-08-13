// Builds the bare provider map + registers each one into a ProviderStateMap
// from the current config. Extracted out of Runtime.reload() -- this part
// doesn't touch the queue, activity log, or any other Runtime instance
// state, it just turns config into providers.
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";
import type { ProviderStateMap } from "../providers/provider-state.js";
import type { GatewayConfig } from "../config.js";

/** Constructs every enabled provider from `config` and registers its
 *  concurrency/RPM limits into `stateMap`. Mutates `stateMap` (register is
 *  additive/idempotent per name); returns the fresh bare-provider map for
 *  the caller to swap in wherever it keeps one. */
export function buildBareProviders(config: GatewayConfig, stateMap: ProviderStateMap): Record<string, Provider> {
  const bareProviders: Record<string, Provider> = {};

  // Anthropic -- skipped entirely when disabled, not just gated at
  // dispatch time. Leaving it out of bareProviders/stateMap means
  // GlobalQueue's fallback loop (`if (!provider) continue`) and
  // ProviderStateMap.canAccept's `if (!entry) return false` both
  // already do the right thing with zero new logic: every fallback
  // set that includes anthropic transparently falls through to its
  // next entry, exactly as if it were permanently cooling.
  if (config.anthropic?.enabled !== false) {
    const anthropicInner = new AnthropicProvider({ apiKey: config.anthropic?.apiKey });
    bareProviders.anthropic = anthropicInner;
    // Anthropic parses its own reset headers from upstream
    // (`anthropic-ratelimit-unified-5h-reset` etc.) — the provider's
    // own cooldown handling is more precise than the global fallback
    // would be. No `cooldownFallbackMs` override on AnthropicConfig,
    // same as the legacy router's shape: Anthropic didn't get one.
    stateMap.register("anthropic", {
      maxConcurrent: config.anthropic?.maxConcurrent,
      rpmLimit: config.anthropic?.rpmLimit,
    });
  }

  // New providers shape
  for (const [name, providerDef] of Object.entries(config.providers ?? {})) {
    if (providerDef.enabled === false) continue;
    const defaultModel = providerDef.models.find((m) => m.enabled) ?? providerDef.models[0];
    if (!defaultModel) continue;
    // Build per-model settings map so the provider can resolve
    // maxOutputTokens (and any future per-model tuning fields) at
    // dispatch time when modelOverride selects a non-default model.
    const modelSettings: Record<string, { maxOutputTokens?: number; maxContextWindow?: number }> = {};
    for (const m of providerDef.models) {
      const entry: { maxOutputTokens?: number; maxContextWindow?: number } = {};
      if (m.maxOutputTokens !== undefined) entry.maxOutputTokens = m.maxOutputTokens;
      if (m.maxContextWindow !== undefined) entry.maxContextWindow = m.maxContextWindow;
      if (Object.keys(entry).length > 0) modelSettings[m.name] = entry;
    }
    const instanceConfig = {
      baseUrl: providerDef.baseUrl,
      model: defaultModel.name,
      apiKey: providerDef.apiKey,
      pricing: defaultModel.pricing,
      maxConcurrent: providerDef.maxConcurrent,
      rpmLimit: providerDef.rpmLimit,
      priority: providerDef.priority,
      emitLateMetadataDelta: providerDef.emitLateMetadataDelta,
      maxRequestBytes: providerDef.maxRequestBytes,
      maxRequestBytesWarnRatio: providerDef.maxRequestBytesWarnRatio,
      models: Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    };
    bareProviders[name] = new OpenAICompatibleProvider(name, instanceConfig);
    stateMap.register(name, {
      maxConcurrent: providerDef.maxConcurrent,
      rpmLimit: providerDef.rpmLimit,
      cooldownFallbackMs: providerDef.cooldownFallbackMs,
    });
  }

  // Legacy openaiCompatibleInstances (backward compat). The legacy
  // shape doesn't carry a `cooldownFallbackMs` field — operators on
  // this path can migrate to the new `providers.<name>` shape if
  // they need per-vendor cooldown defaults (e.g. setting Gemini
  // Free to 5min or Ollama to 30s). Until then, the global 60s
  // default kicks in.
  for (const [name, instance] of Object.entries(config.openaiCompatibleInstances ?? {})) {
    if (bareProviders[name]) continue;
    bareProviders[name] = new OpenAICompatibleProvider(name, instance);
    stateMap.register(name, {
      maxConcurrent: instance.maxConcurrent,
      rpmLimit: instance.rpmLimit,
    });
  }

  return bareProviders;
}
