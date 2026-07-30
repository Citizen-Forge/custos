import type { Runtime } from "../runtime.js";
import type { AnthropicMessagesRequest } from "../types.js";
import { looksRateLimited } from "../providers/rate-limit-signature.js";

export type ProbeReason =
  | "rate-limited"
  | "auth"
  | "decommissioned"
  | "unknown";

/**
 * Thrown by `runPreSpawnProbe` to signal the chosen upstream is not
 * currently usable. Distinct from `ProviderUnavailableError` (which marks
 * retryable cooldown-shaped dispatch failures) -- the agent-runner treats
 * this as a pre-run short-circuit so no `runs.startRun` artefact is left
 * behind for what would otherwise be a 30-second claude -p retry storm.
 *
 * The agent-runner composes this into the returned `AgentRunResult.error`
 * so the orchestrator's existing failure path (`board.addComment`,
 * `board.recordAttemptFailure`) handles it without a new catch block.
 */
export class ProbeUnavailableError extends Error {
  readonly providerKey: string;
  readonly model: string;
  readonly status: number;
  readonly reason: ProbeReason;
  readonly snippet: string;

  constructor(providerKey: string, model: string, status: number, reason: ProbeReason, snippet: string) {
    super(`pre-spawn probe rejected ${providerKey}/${model} (status=${status}, reason=${reason}): ${snippet}`);
    this.providerKey = providerKey;
    this.model = model;
    this.status = status;
    this.reason = reason;
    this.snippet = snippet;
    this.name = "ProbeUnavailableError";
  }
}

/** Keyword-driven failure-mode matcher for upstream error envelopes. The
 *  patterns are deliberately broad: Groq's TPM envelope says
 *  `"tokens per minute (TPM)"`, OpenAI's quota copy says
 *  `"You exceeded your current quota"`, Anthropic's deprecated-model copy
 *  says `"model not found"` (with a model name sandwiched in between
 *  -- matched by the broad `not found` fallback). A false positive is
 *  cheap (skip one turn); a false negative costs the agent thirty
 *  seconds of futile work, so the regex is biased toward catching. */
const PROBE_KEYWORDS: ReadonlyArray<[RegExp, ProbeReason]> = [
  [/invalid api[-_ ]key|incorrect api[-_ ]key|unauthorized|authentication[- ]?(failed|error)|\b401\b|oauth.{0,80}(?:session|token|refresh).{0,40}(?:expired|fail(?:ed)?)|refresh[- ]token.{0,40}(?:fail|expired|invalid)|credential.{0,40}(?:expired|invalid)|api[-_ ]?key.{0,40}(?:expired|invalid)/i, "auth"],
  [/decommissioned|no longer (being )?served|model.{0,80}?(?:is[- ]not[- ]?available|not found)|not found|does not exist|unknown model/i, "decommissioned"],
];

function matchReason(text: string): ProbeReason | null {
  if (looksRateLimited(text)) return "rate-limited";
  for (const [pattern, reason] of PROBE_KEYWORDS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/** Hard ceiling on a single probe round-trip. Slow Ollama cold-loads
 *  (~30 s) or Anthropic cold-starts (~20 s) would otherwise gate every
 *  agent spawn that resolves to them, which is its own retry-storm
 *  shape. On timeout we treat the probe like a slow upstream -- abort
 *  with reason "unknown" so the orchestrator's failure path logs a
 *  clear "probe timed out after 5s" comment instead of letting the
 *  real spawn burn 30 s before failing the same way. */
const PROBE_TIMEOUT_MS = 5_000;

/** Fires a 1-token ping to the resolved provider+model and decides whether
 *  the upstream is currently usable. Bypasses the GlobalQueue so:
 *   1. The agent-runner's already-acquired concurrency slot isn't
 *      double-counted toward `maxConcurrent` while we wait for the
 *      probe's round-trip.
 *   2. A probe failure doesn't pollute the activity log with a
 *      dispatch event / mark-cooling cascade -- the operator sees a
 *      single "pre-spawn probe rejected" line.
 *
 * Outcome policy:
 *   - 2xx            -- proceed.
 *   - 401 / 403      -- ALWAYS abort. Auth drift on the configured key
 *                       would silently fail every future claude -p run.
 *   - 429            -- ALWAYS abort. Even with `Retry-After` parsed,
 *                       the next minute's tokens are reserved and the
 *                       agent is going to fail anyway.
 *   - other 4xx with body matching TPM / RPM / quota / auth /
 *     decommission keywords -- abort with the matched reason. The
 *     auth bucket also catches OAuth session/token-expiry envelopes
 *     like "OAuth session expired and could not be refreshed" --
 *     without that match an OAuth-broken run falls through to "proceed"
 *     and burns 30 s in claude -p before failing identically.
 *   - other 4xx without keyword match -- PROCEED. The model exists
 *     (its endpoint answered); the 4xx is some model-specific oddity
 *     the real request won't repeat.
 *   - 5xx            -- proceed. Transient upstream flakes are the real
 *     run's problem too; the existing dispatch path already
 *     retries/cooldowns via ProviderStateMap on the real request.
 *   - timeout        -- abort as unknown. */
export async function runPreSpawnProbe(
  runtime: Runtime,
  providerKey: string,
  model: string,
): Promise<void> {
  const request: AnthropicMessagesRequest = {
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  };
  let res!: Awaited<ReturnType<typeof runtime.probeProvider>>;
  try {
    res = await Promise.race([
      runtime.probeProvider(providerKey, model, request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === "probe timeout") {
      throw new ProbeUnavailableError(providerKey, model, 0, "unknown", `probe timed out after ${PROBE_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (res.status >= 200 && res.status < 300) return;

  let bodyText = "";
  try {
    bodyText = await new Response(res.body).text();
  } catch {
    // Body stream is already consumed or unreadable; snippet stays empty.
  }
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, " ").trim();

  if (res.status === 401 || res.status === 403) {
    const reason = matchReason(bodyText) ?? "auth";
    throw new ProbeUnavailableError(providerKey, model, res.status, reason, snippet);
  }
  if (res.status === 429) {
    throw new ProbeUnavailableError(providerKey, model, res.status, "rate-limited", snippet);
  }
  const reason = matchReason(bodyText);
  if (reason) throw new ProbeUnavailableError(providerKey, model, res.status, reason, snippet);
  // 5xx and unmatched 4xx fall through to proceed.
}
