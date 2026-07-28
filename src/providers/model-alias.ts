/**
 * Pinned routing aliases of the form `custos:<providerKey>/<model>`.
 *
 * Task and complexity routing both pick a provider for you, which is the
 * right default for a human at a keyboard but wrong for the PM agents: an
 * engineering manager that deliberately put a low-complexity ticket on a
 * free local model has to actually get that model, not whatever the router
 * would have chosen. Claude Code passes `ANTHROPIC_MODEL` straight through
 * as the request's `model`, so encoding the provider in the model string is
 * the one lever that works through an unmodified CLI without depending on
 * custom headers surviving the trip.
 *
 * The alias is stripped before the request leaves Custos -- upstream only
 * ever sees the real model name.
 *
 * A second alias form `custos:fallback/<set-name>` routes through the
 * GlobalQueue instead of the single-provider router, giving per-request
 * failover across the fallback set's provider list. This is how the
 * agent-runner pins agents at spawn time: it resolves the fallback set to
 * the first available provider at that moment, but if that provider 429s
 * mid-run, the next request in the same subprocess falls through to the
 * next entry in the set.
 */
export interface PinnedRoute {
  type: "pinned";
  providerKey: string;
  model: string;
}

export interface FallbackRoute {
  type: "fallback";
  fallbackSet: string;
}

export type ModelAlias = PinnedRoute | FallbackRoute;

const PREFIX = "custos:";

export function formatModelAlias(providerKey: string, model: string): string {
  return `${PREFIX}${providerKey}/${model}`;
}

/** Format a fallback-set alias — `custos:fallback/<set-name>`. The
 * agent-runner uses this when the PM assigned a fallback set to the
 * role (rather than a fixed provider/model). */
export function formatFallbackAlias(setName: string): string {
  return `${PREFIX}fallback/${setName}`;
}

export function parseModelAlias(model: string | undefined): ModelAlias | null {
  if (!model || !model.startsWith(PREFIX)) return null;
  const rest = model.slice(PREFIX.length);

  // custos:fallback/<set-name> — GlobalQueue routing.
  const FALLBACK_MARKER = "fallback/";
  if (rest.startsWith(FALLBACK_MARKER)) {
    const setName = rest.slice(FALLBACK_MARKER.length);
    if (!setName) return null;
    return { type: "fallback", fallbackSet: setName };
  }

  // Only the first slash separates provider from model -- model ids
  // legitimately contain slashes (OpenRouter's "anthropic/claude-sonnet-4",
  // Ollama's "library/qwen2.5"), so splitting on all of them would mangle them.
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { type: "pinned", providerKey: rest.slice(0, slash), model: rest.slice(slash + 1) };
}
