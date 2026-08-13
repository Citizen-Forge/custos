import type { AnthropicMessagesRequest } from "../../../types.js";
import type { FallbackTarget } from "../../../providers/global-queue.js";
import type { GatewayConfig } from "../../../config.js";

/** Builds the dispatch chain for the legacy `general` task's priority list.
 *  Every branch of `/v1/messages` flows through the GlobalQueue now, so the
 *  priority list is reshaped into a `FallbackTarget[]` rather than being
 *  handed to the old ProviderRouter. Anthropic entries inherit the body's
 *  own model since AnthropicProvider reads modelOverride → request.model;
 *  OpenAI-compat entries need an explicit model from the provider's
 *  configured default (the first enabled model, falling back to the first
 *  one declared) because modelOverride drives the upstream request's model
 *  field for those providers. The chain order matches `config.tasks.general`
 *  priority order, since that's what the legacy router honored.
 *
 *  Misconfigured entries (legacy `openaiCompatibleInstances` shape, a
 *  typo, an empty `models: []`) are skipped silently — the alternative
 *  is to dispatch with `model: "unknown"` and surface the upstream's
 *  400/404 to the operator, which reads as a runtime bug. Returning an
 *  empty chain is the caller's signal that there's nothing dispatchable;
 *  `routes.ts` translates that into a ProviderUnavailableError so the
 *  request surfaces a coherent error instead of parking forever in the
 *  queue's enqueue path. */
export function generalChain(body: AnthropicMessagesRequest, config: GatewayConfig): FallbackTarget[] {
  const out: FallbackTarget[] = [];
  for (const entry of config.tasks.general) {
    if (entry.provider === "anthropic") {
      out.push({ provider: "anthropic", model: body.model });
      continue;
    }
    const providerDef = config.providers?.[entry.provider];
    const def = providerDef?.models.find((m) => m.enabled) ?? providerDef?.models[0];
    if (!def) continue;  // provider isn't properly configured for chat — skip rather than dispatch with model "unknown"
    out.push({ provider: entry.provider, model: def.name });
  }
  return out;
}
