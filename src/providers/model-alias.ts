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
 */
export interface PinnedRoute {
  providerKey: string;
  model: string;
}

const PREFIX = "custos:";

export function formatModelAlias(providerKey: string, model: string): string {
  return `${PREFIX}${providerKey}/${model}`;
}

export function parseModelAlias(model: string | undefined): PinnedRoute | null {
  if (!model || !model.startsWith(PREFIX)) return null;
  const rest = model.slice(PREFIX.length);
  // Only the first slash separates provider from model -- model ids
  // legitimately contain slashes (OpenRouter's "anthropic/claude-sonnet-4",
  // Ollama's "library/qwen2.5"), so splitting on all of them would mangle them.
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { providerKey: rest.slice(0, slash), model: rest.slice(slash + 1) };
}
