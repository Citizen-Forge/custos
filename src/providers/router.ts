import { ProviderUnavailableError, type AnthropicMessagesRequest, type TaskKind } from "../types.js";
import type { CompleteOptions, Priority, Provider, ProviderResponse } from "./types.js";
import type { GatewayConfig, ProviderEntry } from "../config.js";
import type { SpendTracker } from "./spend-tracker.js";

const DEFAULT_COOLDOWN_MS = 60_000;

/** Maps task kind to throttle priority. The interactive set covers the
 * paths where a user is mid-turn waiting: chat traffic (general), plus
 * the per-turn classifiers that gate routing before the chat gets a
 * reply. Memory curation is the only background kind today -- a chat
 * in progress shouldn't have to wait behind a curator's queued
 * request on a single-slot locally-hosted Ollama. The mapping is kept
 * in one place rather than threading the priority through every callsite
 * so a future task kind has to be deliberately classified. */
function priorityForTask(task: TaskKind): Priority {
  switch (task) {
    case "memoryCurator":
      return "background";
    case "general":
    case "permissionClassifier":
      return "interactive";
  }
}

export interface RoutedResponse extends ProviderResponse {
  /** Which named instance actually served this request -- may differ from
   * the top-priority entry if that one was on cooldown or over budget.
   * Callers that need to record cost against the right instance (see
   * spend-tracker.ts) read this off the response. */
  providerName: string;
}

/** Tracks per-provider cooldowns (e.g. after a rate-limit) so we skip a
 * provider until it's likely to have recovered, instead of retrying it on
 * every single request. */
class CooldownTracker {
  private readonly coolingUntil = new Map<string, number>();

  /** Records a cooldown deadline for `provider`. Precedence chain for
   * the duration:
   *   1. `retryAfterMs` (from the upstream `Retry-After` header or the
   *      Anthropic-specific reset headers) — most accurate, reflects
   *      what the upstream actually said about recovery time.
   *   2. `fallbackMs` (per-provider config, e.g. Gemini Free's 5min
   *      daily-cap window, Ollama's 30s transient-recovery) — applies
   *      when the upstream gave no usable retry hint.
   *   3. `DEFAULT_COOLDOWN_MS = 60_000` (global) — last-resort default
   *      when neither the upstream nor the config says anything.
   * The chain is intentionally per-call rather than stored on the
   * tracker so a single provider can be configured with different
   * fallbacks across different code paths if needed (it isn't
   * today, but the surface stays open). */
  markUnavailable(provider: string, retryAfterMs?: number, fallbackMs?: number): void {
    const effectiveMs = retryAfterMs ?? fallbackMs ?? DEFAULT_COOLDOWN_MS;
    this.coolingUntil.set(provider, Date.now() + effectiveMs);
  }

  isAvailable(provider: string): boolean {
    const until = this.coolingUntil.get(provider);
    return until === undefined || Date.now() >= until;
  }

  /** Snapshot of provider -> coolingUntilMs for every provider currently
   * on cooldown. Used by the runtime stats surface so the admin UI and
   * any alert rule can see "why is this provider skipped" alongside
   * the throttle queue depth. Returns ms epoch values. */
  snapshot(): Array<[string, number]> {
    return [...this.coolingUntil.entries()];
  }
}

/** Circuit breaker on sustained 429/503s. Distinct from CooldownTracker:
 * the cooldown is per-failure (Retry-After / fallback / 60s default),
 * whereas the breaker aggregates multiple consecutive failures into an
 * exponentially-growing extended cooldown. Without the breaker, a
 * persistently-throttled provider keeps getting 1 request per
 * cooldown (e.g. every 60s) and never recovers because each retry
 * re-trips the same short cooldown. The breaker detects "5+ failures
 * in a 60s window" and bumps the cooldown to `60s * 2^openCount`
 * capped at 30 minutes, so the upstream actually gets breathing room
 * to recover instead of being hammered every minute.
 *
 * State per provider:
 *   - recent failure timestamps (sliding 60s window)
 *   - consecutive-open count (resets on success)
 *   - current open deadline (ms epoch)
 *
 * Half-open is implicit: when the breaker deadline expires, both the
 * breaker's `breakerUntil` and `cooldownTracker`'s deadline point at
 * the same instant, so the next `complete()` call goes through. If
 * it succeeds, `recordSuccess()` zeroes the open count so the next
 * trip starts at BASE_COOLDOWN_MS again. If it fails, the breaker
 * re-trips at the next exponential step.
 *
 * The `now` parameter is injectable on every method so unit tests
 * can advance the breaker clock without wall-clock waits. Production
 * callers omit it and get Date.now(). */
class CircuitBreaker {
  /** Width of the sliding failure-count window. Failures older than
   *  this from the current timestamp are pruned and don't count
   *  toward the threshold. */
  static readonly WINDOW_MS = 60_000;
  /** Number of failures within the window that trips the breaker. */
  static readonly THRESHOLD = 5;
  /** Cooldown applied on the first trip. Each subsequent trip
   *  doubles this, capped at MAX_COOLDOWN_MS. */
  static readonly BASE_COOLDOWN_MS = 60_000;
  /** Maximum cooldown across repeated trips. Prevents the breaker
   *  from extending into multi-hour outages that would mask
   *  recoveries the operator actually wants to see. */
  static readonly MAX_COOLDOWN_MS = 30 * 60 * 1000;

  private readonly recentFailures = new Map<string, number[]>();
  private readonly consecutiveOpens = new Map<string, number>();
  private readonly breakerUntil = new Map<string, number>();

  /** Records a failure timestamp and returns the new breaker deadline
   *  if this failure crossed the threshold (>= THRESHOLD failures
   *  within the last WINDOW_MS), else undefined. The deadline is
   *  `now + cooldown` where `cooldown = BASE_COOLDOWN_MS * 2^openCount`
   *  capped at MAX_COOLDOWN_MS. */
  recordFailure(provider: string, now = Date.now()): number | undefined {
    const failures = this.recentFailures.get(provider) ?? [];
    failures.push(now);
    const cutoff = now - CircuitBreaker.WINDOW_MS;
    // Prune timestamps older than the window. Shift is O(n) but the
    // window is bounded by the THRESHOLD (5 entries max in steady
    // state), so this stays cheap.
    while (failures.length > 0 && failures[0] < cutoff) failures.shift();
    this.recentFailures.set(provider, failures);

    if (failures.length < CircuitBreaker.THRESHOLD) return undefined;

    const openCount = this.consecutiveOpens.get(provider) ?? 0;
    const cooldown = Math.min(
      CircuitBreaker.BASE_COOLDOWN_MS * Math.pow(2, openCount),
      CircuitBreaker.MAX_COOLDOWN_MS,
    );
    const deadline = now + cooldown;
    this.breakerUntil.set(provider, deadline);
    this.consecutiveOpens.set(provider, openCount + 1);
    return deadline;
  }

  /** Resets the breaker state for `provider`. Called after a
   *  successful `complete()` so the consecutive-open count returns to
   *  0 and the next trip starts at BASE_COOLDOWN_MS instead of an
   *  exponential step. The recent-failure list is also cleared so a
   *  recovered provider gets a fresh window rather than carrying
   *  stale entries from before its recovery. */
  recordSuccess(provider: string): void {
    this.recentFailures.delete(provider);
    this.consecutiveOpens.delete(provider);
  }

  /** True while the breaker is OPEN (deadline in the future). */
  isOpen(provider: string, now = Date.now()): boolean {
    const until = this.breakerUntil.get(provider);
    return until !== undefined && now < until;
  }

  /** Snapshot of provider -> breakerUntilMs (only providers currently
   *  OPEN are included; expired entries are filtered out). Mirrors
   *  CooldownTracker's snapshot shape so the runtime stats surface
   *  can overlay breaker state onto each throttled provider's stats. */
  snapshot(): Array<[string, number]> {
    const now = Date.now();
    return [...this.breakerUntil.entries()].filter(([, until]) => until > now);
  }
}

/** Told about every provider-level availability change, so something
 * outside the router (the model registry the engineering manager reads) can
 * know a subscription window is exhausted instead of inferring it from
 * failed runs. */
export interface AvailabilityListener {
  onUnavailable(providerName: string, retryAfterMs: number, reason: string): void;
  onAvailable(providerName: string): void;
}

export class ProviderRouter {
  private readonly cooldownTracker = new CooldownTracker();
  private readonly circuitBreaker = new CircuitBreaker();
  private listener: AvailabilityListener | null = null;

  constructor(
    private readonly providers: Record<string, Provider>,
    /** Active gateway config. Public so runtime-adjacent callers
     *  (curator, permission classifier, global-agent routes) can
     *  derive provider-specific URLs and primary picks without taking
     *  on a full Runtime reference; reading from the router keeps the
     *  source of truth in one place. The router holds the same
     *  GatewayConfig Runtime does, so a config reload is visible here
     *  on the next read. */
    public readonly config: GatewayConfig,
    private readonly spendTracker: SpendTracker,
  ) {}

  setAvailabilityListener(listener: AvailabilityListener): void {
    this.listener = listener;
  }

  /** Per-provider cooldown deadlines as a snapshot map. Empty when no
   * provider is currently cooling down. The runtime stats surface
   * overlays these onto each throttled provider's stats; non-throttled
   * providers that happen to be on cooldown (rare, e.g. Anthropic with
   * no maxConcurrent configured) won't appear in the stats output --
   * visible only in the router's error message stream. */
  cooldowns(): Record<string, number> {
    return Object.fromEntries(this.cooldownTracker.snapshot());
  }

  /** Per-provider circuit-breaker deadlines as a snapshot map. Empty
   * when no breaker is currently OPEN. The runtime stats surface
   * overlays these onto each throttled provider's stats so the admin
   * UI can distinguish "circuit-broken, retrying in 8min" from a
   * plain "cooling down". */
  breakers(): Record<string, number> {
    return Object.fromEntries(this.circuitBreaker.snapshot());
  }

  /** Looks up a fixed task's configured priority list. The task-derived
   * throttle priority is the default; an explicit `options.priority` wins
   * (rare -- direct callers might want to send a synthetic request as
   * background without reverse-engineering the task kind). The full
   * precedence chain -- caller > instance > task default -- is resolved
   * per-entry inside completeWithEntries, so we don't pre-stamp
   * `merged.priority` here: doing so would lose the signal that
   * distinguishes "caller didn't set a priority" from "caller set it to
   * the task default", and the instance-level override wouldn't get a
   * chance to win. */
  async complete(task: TaskKind, request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<RoutedResponse> {
    return this.completeWithEntries(this.config.tasks[task], request, options, `task "${task}"`, task);
  }

  /** Runs the same priority/failover logic against an explicit entry list
   * instead of a fixed task -- used for complexity-tier routing, where the
   * entry list is picked dynamically per-turn rather than being one of the
   * fixed task kinds. The optional `task` parameter is the only way the
   * per-entry priority resolver knows what the task-derived fallback
   * should be; direct callers that don't have a task kind (e.g. the
   * complexity-tier path) leave it unset and the fallback is "interactive". */
  async completeWithEntries(
    entries: ProviderEntry[],
    request: AnthropicMessagesRequest,
    options?: CompleteOptions,
    label = "entries",
    task?: TaskKind,
  ): Promise<RoutedResponse> {
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    let lastError: Error | undefined;
    // Why each candidate was passed over. Without this a skipped provider
    // produced "no provider is configured", which reads as a configuration
    // mistake when the real reason is usually a live cooldown or a spent
    // budget -- and sends you to check the wrong thing.
    const skipped: string[] = [];

    for (const entry of sorted) {
      const provider = this.providers[entry.provider];
      if (!provider) {
        skipped.push(`"${entry.provider}" is not a configured provider`);
        continue;
      }
      if (!this.cooldownTracker.isAvailable(provider.name)) {
        skipped.push(`"${entry.provider}" is cooling down after a rate limit or outage`);
        continue;
      }

      // Per-instance priority resolution. Precedence:
      // Priority comes from either the new `providers` shape or
      // the deprecated `openaiCompatibleInstances` shape, whichever is
      // present. The router doesn't care about the hierarchy -- it only
      // needs the values associated with this provider name.
      const providerDef = this.config.providers?.[entry.provider];
      const instanceConfig = this.config.openaiCompatibleInstances[entry.provider];
      //   1. caller-supplied `options.priority` (highest)
      //   2. instance-pinned `priority` from config.json (overrides the
      //      task default for this provider specifically)
      //   3. task-derived default (or "interactive" when no task is in scope)
      // Resolving per-entry rather than once in complete() is what makes
      // the instance override possible -- each candidate gets a chance to
      // contribute its own priority before its request is dispatched.
      const instancePriority = providerDef?.priority ?? instanceConfig?.priority;
      const resolvedPriority: Priority = options?.priority
        ?? instancePriority
        ?? (task ? priorityForTask(task) : "interactive");
      const mergedOptions: CompleteOptions = { ...options, priority: resolvedPriority };

      try {
        const response = await provider.complete(request, mergedOptions);
        // A success is proof the window reopened, whatever we last recorded.
        // Reset the circuit breaker's consecutive-open count so the next
        // trip starts at BASE_COOLDOWN_MS (60s) instead of carrying the
        // exponential step over from before the recovery.
        this.circuitBreaker.recordSuccess(provider.name);
        this.listener?.onAvailable(provider.name);
        return { ...response, providerName: provider.name };
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          // Per-vendor cooldown fallback: Gemini Free quota caps
          // regenerate on minute-scale windows; Ollama on a saturated
          // local recovers in a few seconds; Anthropic continues to
          // carry its own reset timestamps via the Anthropic-specific
          // headers and never falls back here. Without this override,
          // every provider without a Retry-After header would silently
          // use the 60s global default, which is wrong-shaped for the
          // examples above. The fallback is per-provider config -- not
          // a per-error-type -- because the relevant recovery window is
          // a property of the upstream API, not of the failure shape.
          const fallbackMs = this.config.providers?.[entry.provider]?.cooldownFallbackMs;
          const effectiveRetryAfterMs = err.retryAfterMs ?? fallbackMs ?? DEFAULT_COOLDOWN_MS;
          this.cooldownTracker.markUnavailable(provider.name, err.retryAfterMs, fallbackMs);

          // Circuit breaker: after this ProviderUnavailableError, check
          // whether the threshold was crossed. The breaker's deadline
          // (if any) extends the regular cooldown when the breaker's
          // duration is longer -- i.e., once the breaker has tripped at
          // least once. On the very first trip the base cooldown equals
          // the default cooldown (both 60s), so the override is a no-op;
          // on the second trip (120s) and beyond, the breaker duration
          // is what actually matters and overrides the regular cooldown.
          // The cooldownTracker is updated with the breaker duration so
          // `isAvailable()` skips the provider for the full breaker
          // window. The reason string carries "circuit-broken" so the
          // admin UI can distinguish from a plain 429.
          const breakerDeadline = this.circuitBreaker.recordFailure(provider.name);
          let effectiveCooldownMs = effectiveRetryAfterMs;
          let reason: string;
          if (breakerDeadline !== undefined) {
            const breakerCooldownMs = breakerDeadline - Date.now();
            if (breakerCooldownMs > effectiveCooldownMs) {
              this.cooldownTracker.markUnavailable(provider.name, breakerCooldownMs);
              effectiveCooldownMs = breakerCooldownMs;
            }
            reason = `circuit-broken: ${CircuitBreaker.THRESHOLD} failures in ${CircuitBreaker.WINDOW_MS / 1000}s window (cooldown: ${Math.round(effectiveCooldownMs / 1000)}s)`;
          } else {
            reason = err.message;
          }

          // Anthropic's 429 carries its own 5-hour unified reset, so this is
          // the exact moment and duration a subscription window is known to
          // be exhausted -- the one signal worth telling the manager about.
          this.listener?.onUnavailable(provider.name, effectiveCooldownMs, reason);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    // Surface why, not just that. "No provider available" reads like a
    // misconfiguration and sends people to check their settings, when the
    // real cause is nearly always the last provider's own reason for
    // refusing -- an exhausted session window, a rate limit, a rejected key.
    if (lastError) throw lastError;
    if (skipped.length) throw new ProviderUnavailableError(`${label}: ${skipped.join("; ")}`);
    throw new ProviderUnavailableError(`${label}: no providers were offered for this request`);
  }
}

/** Test-only export of the inner CircuitBreaker class so unit tests
 *  can drive the breaker directly with synthetic clocks. Production
 *  callers should never import this -- the breaker is an
 *  implementation detail of ProviderRouter, and its surface (the
 *  `THRESHOLD` / `WINDOW_MS` / `BASE_COOLDOWN_MS` / `MAX_COOLDOWN_MS`
 *  constants) is exposed via the class symbol for test introspection
 *  and operator-facing message strings, not for direct API use. */
export { CircuitBreaker };
