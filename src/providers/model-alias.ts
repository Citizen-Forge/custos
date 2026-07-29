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
  /** Optional caller context recovered from the alias suffix. */
  context?: FallbackContext;
}

export interface FallbackRoute {
  type: "fallback";
  fallbackSet: string;
  /** Optional caller context recovered from the alias suffix. */
  context?: FallbackContext;
}

/** Caller-supplied metadata that travels inside the alias so the global
 *  queue can attribute dispatch events back to the project + agent that
 *  triggered them. Encoded as a URL-encoded JSON blob after `?` on the
 *  alias; the parser ignores a malformed or missing suffix. Keys are
 *  deliberately permissive -- only the ones the dispatcher reads are
 *  typed below; future fields round-trip without changes here. */
export interface FallbackContext {
  projectId?: string;
  projectName?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
}

export type ModelAlias = PinnedRoute | FallbackRoute;

const PREFIX = "custos:";
const FALLBACK_MARKER = "fallback/";

export function formatModelAlias(providerKey: string, model: string): string {
  return `${PREFIX}${providerKey}/${model}`;
}

/** Format a fallback-set alias — `custos:fallback/<set-name>`. The
 * agent-runner uses this when the PM assigned a fallback set to the
 * role (rather than a fixed provider/model). When a context is supplied
 * (and carries at least one field), it is URL-encoded and appended
 * after `?` so the gateway can recover it at dispatch time and attribute
 * queue events to the project + agent that triggered them. The `?`
 * delimiter never appears in a set name (the same identifier syntax
 * as a config key), so the parser can split cleanly. */
export function formatFallbackAlias(setName: string, context?: FallbackContext): string {
  if (!context || Object.keys(context).length === 0) return `${PREFIX}${FALLBACK_MARKER}${setName}`;
  const ctxStr = encodeURIComponent(JSON.stringify(context));
  return `${PREFIX}${FALLBACK_MARKER}${setName}?${ctxStr}`;
}

/** Parse a context suffix (after `?`) on an alias. Returns undefined on
 *  malformed input rather than throwing -- the dispatcher treats a bad
 *  suffix as "no context" and continues, which is the same behavior as
 *  the bare alias. */
function parseContextSuffix(suffix: string | undefined): FallbackContext | undefined {
  if (!suffix) return undefined;
  try {
    const decoded = decodeURIComponent(suffix);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const ctx: FallbackContext = {};
    if (typeof parsed.projectId === "string") ctx.projectId = parsed.projectId;
    if (typeof parsed.projectName === "string") ctx.projectName = parsed.projectName;
    if (typeof parsed.agentId === "string") ctx.agentId = parsed.agentId;
    if (typeof parsed.agentName === "string") ctx.agentName = parsed.agentName;
    if (typeof parsed.role === "string") ctx.role = parsed.role;
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  } catch {
    return undefined;
  }
}

export function parseModelAlias(model: string | undefined): ModelAlias | null {
  if (!model || !model.startsWith(PREFIX)) return null;
  const rest = model.slice(PREFIX.length);

  // custos:fallback/<set-name>?<urlencoded-json> — GlobalQueue routing,
  // optionally with caller context appended after `?` so the dispatcher
  // can attribute events back to the project + agent that triggered the
  // request. The set name cannot contain `?`, so splitting on the first
  // `?` cleanly separates the two halves.
  if (rest.startsWith(FALLBACK_MARKER)) {
    const tail = rest.slice(FALLBACK_MARKER.length);
    const qIdx = tail.indexOf("?");
    let setName: string;
    let context: FallbackContext | undefined;
    if (qIdx >= 0) {
      setName = tail.slice(0, qIdx);
      context = parseContextSuffix(tail.slice(qIdx + 1));
    } else {
      setName = tail;
    }
    if (!setName) return null;
    return context ? { type: "fallback", fallbackSet: setName, context } : { type: "fallback", fallbackSet: setName };
  }

  // Only the first slash separates provider from model -- model ids
  // legitimately contain slashes (OpenRouter's "anthropic/claude-sonnet-4",
  // Ollama's "library/qwen2.5"), so splitting on all of them would mangle them.
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { type: "pinned", providerKey: rest.slice(0, slash), model: rest.slice(slash + 1) };
}
