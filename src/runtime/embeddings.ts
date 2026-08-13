// Resolves the embeddings global agent + current config into a usable
// EmbeddingConfig. Pure: no I/O of its own (the agent is fetched by the
// caller), just the URL/path resolution rules.
import type { GatewayConfig } from "../config.js";
import type { EmbeddingConfig } from "../memory/embeddings.js";
import { resolveEmbeddingHost, looksLikeOllamaEndpoint } from "../providers/embedding-url.js";
import * as agentStore from "../pm/agents.js";
import type { AgentDef } from "../pm/types.js";

/** Resolve a usable `EmbeddingConfig` from the embeddings global agent and
 *  the current config. Returns null (with a console.warn explaining why)
 *  when the agent has no live primary pick or references a missing
 *  provider -- callers handle that by skipping embedding-dependent work
 *  rather than crashing. */
export function resolveEmbeddingTarget(agent: AgentDef, config: GatewayConfig): EmbeddingConfig | null {
  // Resolve the embeddings provider through the global agent's
  // fallbackSet rather than reading a stale `agent.providerKey`. The
  // agent-row field was dropped along with `AgentDef.providerKey` /
  // `model` in the schema-cleanup commit; primaryPick is the single
  // source of truth for "which provider does this agent currently
  // dispatch to" across the runtime.
  const pick = agentStore.primaryPick(agent, config);
  if (!pick) {
    console.warn(`embeddings global agent has no live primary pick (fallbackSet="${agent.fallbackSet ?? "<unset>"}"); embedding disabled until a fallback set is assigned`);
    return null;
  }
  const providerDef = config.providers?.[pick.providerKey];
  if (!providerDef) {
    console.warn(`embeddings global agent references missing provider "${pick.providerKey}"; embedding disabled until a provider exists`);
    return null;
  }
  // The full URL-resolution-rule chain lives in
  // `src/providers/embedding-url.ts` so the admin probe endpoint and
  // this runtime derive the same host for any given config. Three
  // inputs in priority order:
  //   1. `agent.embeddingBaseUrl` (set on the global agent) — explicit
  //      per-agent override; wins outright.
  //   2. `providerDef.embeddingUrl` (set on the named provider) —
  //      provider-level override; useful when pointing the embeddings
  //      agent at a provider whose chat baseUrl is on a non-default
  //      port or protocol.
  //   3. URL-shape heuristic — baseUrl with port 11430-11440 or
  //      hostname containing "ollama" implies Ollama's native
  //      /api/embeddings path on the bare origin (the chat path's
  //      /v1 prefix is stripped for the embeddings target). Anything
  //      else is OpenAI-compat and the consumer falls through to
  //      whatever the named provider exposes.
  const baseUrl = resolveEmbeddingHost({
    agentOverride: agent.embeddingBaseUrl,
    providerEmbeddingUrl: providerDef.embeddingUrl,
    providerBaseUrl: providerDef.baseUrl,
  });

  // Determine the embeddings path and body format from the provider's
  // URL shape. Ollama's native endpoint lives at `/api/embeddings` (the
  // bare origin, no `/v1` prefix) and expects `{model, prompt}`.
  // OpenAI-compat providers expose `/embeddings` (under their existing
  // path prefix, e.g. `/v1/embeddings`) and expect `{model, input}`.
  // The heuristic checks the agent override first (most specific), then
  // the provider embedding URL override, then the provider base URL.
  const isOllama = looksLikeOllamaEndpoint(
    agent.embeddingBaseUrl ?? providerDef.embeddingUrl ?? providerDef.baseUrl,
  );

  return {
    baseUrl,
    path: isOllama ? "/api/embeddings" : "/embeddings",
    model: pick.model,
  };
}
