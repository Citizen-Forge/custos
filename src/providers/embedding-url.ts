/**
 * Where the embeddings POST should land. The runtime and the admin probe
 * both call `resolveEmbeddingHost` so a user's UI choice and the runtime's
 * actual fetch URL can't drift apart -- a "probe says ✓" check means the
 * runtime will succeed on the next refreshEmbedding call.
 *
 * Three inputs, in priority order:
 *
 *   1. `agentOverride` — the global embeddings agent's `embeddingBaseUrl`
 *      field. Set when a user wants to point embeddings at a host that
 *      differs from the chat provider (e.g. a remote Ollama, or a
 *      purpose-built embedding service). Wins over everything.
 *
 *   2. `providerEmbeddingUrl` — explicit provider-level override. Set via
 *      the admin UI when the named provider doesn't follow either default
 *      convention (OpenAI-compat at /v1/embeddings, custom path, etc.).
 *
 *   3. Heuristic default from provider.baseUrl:
 *        - Ollama-like endpoint → strip a trailing `/v1` and let the
 *          consumer POST to `/api/embeddings` (Ollama's native path).
 *        - Otherwise → use baseUrl as-is and let the consumer POST to
 *          whatever the URL convention is (typically `/v1/embeddings`).
 *
 * Detection is *URL-shape*, never providerKey-based. Renaming the default
 * `ollama` preset to e.g. `local`, or pointing a custom providerKey at
 * `host:11434/v1`, still routes embeddings through Ollama's native
 * endpoint without anyone hand-configuring the override.
 *
 * The consumer (`src/memory/embeddings.ts`) reads `config.path` from the
 * `EmbeddingConfig` the runtime builds in `refreshEmbedding()`. The path
 * determines both the URL suffix (`/api/embeddings` for Ollama,
 * `/embeddings` for OpenAI-compat) and the body format (`{model, prompt}`
 * vs `{model, input}`). This function is the single place that computes
 * the host; the path is chosen by `refreshEmbedding()` from the same
 * `looksLikeOllamaEndpoint` heuristic, so the probe preview and the
 * runtime fetch can't disagree.
 */

export interface ResolveEmbeddingUrlInput {
  /** Global agent's `embeddingBaseUrl`. Full URL. Wins when set. */
  agentOverride?: string;
  /** ProviderDef's explicit `embeddingUrl`. Full URL. Wins over heuristic. */
  providerEmbeddingUrl?: string;
  /** The provider's chat `baseUrl`. Heuristic-derives when nothing is set. */
  providerBaseUrl: string;
  /** Drop a trailing `/api/embeddings` or `/embeddings` so the consumer
   *  can re-attach the canonical suffix without double-pathing. */
  stripTrailingEmbeddingPath?: boolean;
}

/** Whether `baseUrl` points at a local Ollama-like service. The two
 *  signals that matter:
 *  - Port 11430-11440 is what Ollama's default install listens on. The
 *    narrow range catches both Ollama (11434) and llama.cpp-running-as-
 *    Ollama (default 11434 still) while excluding unrelated services
 *    that happen to be on 11400ish ports.
 *  - Hostname containing "ollama" flags Docker network aliases that route
 *    a renamed provider back at a real Ollama container behind a service
 *    mesh. */
export function looksLikeOllamaEndpoint(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return /11434|1143\d/i.test(baseUrl) || /ollama/i.test(baseUrl);
  }
  if (u.hostname && u.hostname.toLowerCase().includes("ollama")) return true;
  if (u.port) {
    const n = Number(u.port);
    if (Number.isFinite(n) && n >= 11430 && n <= 11440) return true;
  }
  return false;
}

export function resolveEmbeddingHost(input: ResolveEmbeddingUrlInput): string {
  // Strip a trailing "embedding path" so a full URL the user passes
  // here (e.g. "http://h:11434/api/embeddings") becomes a host the
  // consumer can re-attach its canonical suffix to without doubling
  // up the path.
  const stripPath = input.stripTrailingEmbeddingPath ?? true;

  if (input.agentOverride) {
    return stripPath ? stripTrailingEmbeddingPath(input.agentOverride) : input.agentOverride;
  }
  if (input.providerEmbeddingUrl) {
    return stripPath ? stripTrailingEmbeddingPath(input.providerEmbeddingUrl) : input.providerEmbeddingUrl;
  }
  const normalized = input.providerBaseUrl.replace(/\/+$/, "");
  if (looksLikeOllamaEndpoint(input.providerBaseUrl)) {
    // The chat path is /v1/chat/completions; the embeddings native
    // path is /api/embeddings on the bare origin. Strip trailing /v1.
    return normalized.replace(/\/v1\/?$/, "");
  }
  return normalized;
}

function stripTrailingEmbeddingPath(url: string): string {
  return url
    .replace(/\/api\/embeddings\/?$/, "")
    .replace(/\/embeddings\/?$/, "");
}

/** Diagnostic — given a baseUrl, return the host the runtime WOULD derive
 *  today, the heuristic reason ("ollama-shape" vs "default"), and the
 *  candidate paths the admin probe-embeddings endpoint should hit. The
 *  Admin UI shows this verbatim so the user can sanity-check before
 *  Save. */
export interface EmbeddingProbePlan {
  host: string;
  reason: "agent-override" | "provider-override" | "ollama-shape" | "openai-shape";
  candidates: Array<{ path: string; shape: "ollama" | "openai-compat" }>;
}

export function planEmbeddingProbe(input: ResolveEmbeddingUrlInput): EmbeddingProbePlan {
  let host: string;
  let reason: EmbeddingProbePlan["reason"];
  if (input.agentOverride) {
    host = stripTrailingEmbeddingPath(input.agentOverride);
    reason = "agent-override";
  } else if (input.providerEmbeddingUrl) {
    host = stripTrailingEmbeddingPath(input.providerEmbeddingUrl);
    reason = "provider-override";
  } else if (looksLikeOllamaEndpoint(input.providerBaseUrl)) {
    host = input.providerBaseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    reason = "ollama-shape";
  } else {
    host = input.providerBaseUrl.replace(/\/+$/, "");
    reason = "openai-shape";
  }
  // Ollama-style POSTs hit /api/embeddings with {model, prompt}.
  // OpenAI-compat POSTs hit /embeddings with {model, input}. The
  // probe endpoint pings both so the operator can confirm the runtime's
  // pick is right without waiting for the next 4xx error.
  const candidates: EmbeddingProbePlan["candidates"] = reason === "ollama-shape"
    ? [{ path: "/api/embeddings", shape: "ollama" }]
    : [{ path: "/embeddings", shape: "openai-compat" }];
  return { host, reason, candidates };
}
