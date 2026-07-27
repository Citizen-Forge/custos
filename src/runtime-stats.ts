// Periodic stats monitor + sustained-threshold alerts for the runtime.
//
// Exposes throttle queue depth as a metric so the team can spot saturating
// providers BEFORE they show up as user-visible latency. Three concerns
// live here, decoupled so each can be configured independently:
//
//   - Optional periodic snapshot logging (off by default; the admin
//     stats endpoint is the primary on-demand viewer).
//   - Sustained-threshold alerts that fire warn-level log lines once a
//     metric has been over its threshold for longer than the rule's
//     sustainedMs window. Always on; the default rules pin the canonical
//     cases (curator-stuck and chat-backup) and callers can pass their
//     own rule set.
//   - State tracking for the threshold alerts -- keyed by
//     `${ruleId}:${providerName}` so multiple rules on the same provider
//     (and multiple providers on the same rule) carry independent state.
//
// Per tick:
//   1. Read RuntimeStats from the callback supplied at construction
//   2. (Optional) log the snapshot at info level
//   3. For each (rule, provider) pair, evaluate the rule's extractor
//      against the current value and emit crossed / sustained / cleared
//      log lines as appropriate
//
// The threshold monitor drives all state transitions from one tick's
// snapshot -- no delta-tracking across ticks. This means a tick that
// happens to land just after a recovery won't see a stale "crossed" and
// fire a phantom alert; the cleared-then-recrossed path resets the
// per-(rule, provider) timer cleanly because the threshold isn't met
// in the intermediate ticks.

import type { ProviderRuntimeStats, RuntimeStats } from "./runtime.js";

export interface AlertRule {
  /** Stable id. Used to key the monitor's internal state, so a rule
   * added twice (e.g. by two callers appending to DEFAULT_ALERT_RULES)
   * still pins a single source of truth per id. */
  id: string;
  /** Per-provider extractor. Return the metric value when the rule
   * applies to that provider, null when it doesn't (e.g. queuedBackground
   * doesn't apply to a provider with no background traffic to measure).
   * The alert machinery treats `value > threshold` as "rule triggered". */
  extract: (provider: ProviderRuntimeStats) => number | null;
  /** Inclusive upper bound for "not triggered". 50 means values <= 50
   * never trigger; values > 50 do. */
  threshold: number;
  /** How long the threshold must remain exceeded before the sustained
   * alert fires. Shorter crossings reset without alerting. */
  sustainedMs: number;
  message: (providerName: string, value: number) => string;
}

export interface StatsLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const CONSOLE_LOGGER: StatsLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

/** Default rule set:
 *   - queuedBackground > 50 for 5 minutes: the canonical "memory curator
 *     is stuck" alert. A curator running locally on Ollama typically
 *     completes in seconds; 50 queued background requests for 5 minutes
 *     is almost always a stuck worker or a runaway fan-out.
 *   - queuedInteractive > 20 for 1 minute: catches interactive backlogs
 *     before they become user-visible latency -- 20 queued chats for a
 *     minute means the provider is overwhelmed and chats are stacking
 *     up. Tuned tighter than the curator rule because interactive queue
 *     growth is the user-facing symptom. */
export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: "queued-background-curator-stuck",
    extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
    threshold: 50,
    sustainedMs: 5 * 60 * 1000,
    message: (name, value) => `${name} has ${value} background requests queued -- memory curator may be stuck`,
  },
  {
    id: "queued-interactive-backup",
    extract: (p) => (p.queuedInteractive > 0 ? p.queuedInteractive : null),
    threshold: 20,
    sustainedMs: 60 * 1000,
    message: (name, value) => `${name} has ${value} interactive requests queued -- chat traffic backing up`,
  },
];

export interface StatsMonitorOptions {
  intervalMs: number;
  rules: AlertRule[];
  logger?: StatsLogger;
  /** When true, every tick logs the full snapshot at info level. Off
   * by default; the admin endpoint is the primary on-demand viewer and
   * 30s snapshots are noisy without a downstream log scraper. */
  logSnapshot?: boolean;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export class StatsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per `${ruleId}:${providerName}`: ms epoch when the threshold was
   * first crossed. Reset to undefined when the value drops below
   * threshold (whether or not the sustained alert ever fired). */
  private readonly crossedAt = new Map<string, number>();
  /** Per `${ruleId}:${providerName}`: whether the sustained alert has
   * already fired for the current crossing. Cleared alongside
   * crossedAt on recovery. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly getStats: () => RuntimeStats,
    private readonly options: StatsMonitorOptions,
  ) {}

  /** Start the periodic tick. Idempotent -- a second call is a no-op so
   * Runtime.reload() can re-initialize without stacking timers. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    // Don't keep the process alive for this timer; if the rest of the
    // server has shut down, the process can exit cleanly.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single tick. Public so tests can drive it deterministically
   * without waiting on setInterval. Catches and logs any error from the
   * stats callback so a transient fault doesn't silently stop the
   * monitor — setInterval discards thrown exceptions without recovery. */
  tick(): void {
    const now = this.options.now?.() ?? Date.now();
    const logger = this.options.logger ?? CONSOLE_LOGGER;
    let stats: RuntimeStats;
    try {
      stats = this.getStats();
    } catch (err) {
      logger.warn(`[stats] tick error: ${(err as Error).message ?? err}`);
      return;
    }
    if (this.options.logSnapshot) {
      logger.info(this.formatSnapshot(stats));
    }
    for (const rule of this.options.rules) {
      for (const [providerName, providerStats] of Object.entries(stats.providers)) {
        this.evaluateRule(rule, providerName, providerStats, now, logger);
      }
    }
  }

  private formatSnapshot(stats: RuntimeStats): string {
    const parts = Object.entries(stats.providers).map(([name, p]) => {
      const fields = [`active=${p.active}`, `qi=${p.queuedInteractive}`, `qb=${p.queuedBackground}`];
      if (p.maxConcurrent > 0) fields.push(`slots=${p.active}/${p.maxConcurrent}`);
      if (p.cooldownUntil) fields.push(`cooldownUntil=${new Date(p.cooldownUntil).toISOString()}`);
      return `${name}(${fields.join(",")})`;
    });
    return `[stats] ${parts.join(" ")}`;
  }

  private evaluateRule(
    rule: AlertRule,
    providerName: string,
    provider: ProviderRuntimeStats,
    now: number,
    logger: StatsLogger,
  ): void {
    const key = `${rule.id}:${providerName}`;
    const value = rule.extract(provider);
    const triggered = value !== null && value > rule.threshold;
    if (triggered) {
      const crossed = this.crossedAt.get(key);
      if (crossed === undefined) {
        this.crossedAt.set(key, now);
        logger.info(
          `[stats] threshold crossed: ${rule.message(providerName, value)} (threshold ${rule.threshold}, sustained ${rule.sustainedMs}ms)`,
        );
      } else if (!this.alerted.has(key) && now - crossed >= rule.sustainedMs) {
        this.alerted.add(key);
        const durationSec = Math.round((now - crossed) / 1000);
        logger.warn(
          `[stats] ALERT: ${rule.message(providerName, value)} (crossed threshold ${rule.threshold} for ${durationSec}s)`,
        );
      }
    } else {
      if (this.crossedAt.has(key)) {
        logger.info(`[stats] threshold cleared: ${rule.message(providerName, value ?? 0)}`);
        this.crossedAt.delete(key);
        this.alerted.delete(key);
      }
    }
  }
}
