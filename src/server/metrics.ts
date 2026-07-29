// Prometheus /metrics endpoint exposing throttle queue depth and cooldown
// state as gauge metrics so the live stats surface integrates with standard
// infra monitoring (Prometheus scrape, Grafana dashboards, alertmanager)
// instead of requiring a custom log scraper or polling the admin JSON API.
//
// The Runtime.stats() snapshot is re-read on every scrape – no caching, so
// the metric line always reflects the current load at request time.
// Overhead scales with the number of throttled providers (typically 2–5);
// formatting OpenMetrics text for a handful of gauges is sub-millisecond.

import type { FastifyInstance } from "fastify";
import type { Runtime, ProviderRuntimeStats } from "../runtime.js";

/** Help prefix and type prefix are emitted once per stat family. Keeping
 *  them here avoids repeating the same constants on every scrape. */
const GAUGE_HELP: Record<string, string> = {
  custos_throttle_active: "Currently in-flight requests (per provider)",
  custos_throttle_queued_interactive: "Queue depth for interactive requests (per provider)",
  custos_throttle_queued_background: "Queue depth for background requests (per provider)",
  custos_throttle_queued_total: "Total queue depth (interactive + background, per provider)",
  custos_throttle_slots_utilization: "Slots utilization as a ratio active/maxConcurrent (0–1, per provider)",
};

export function registerMetricsRoute(app: FastifyInstance, runtime: Runtime): void {
  app.get("/metrics", async (_req, reply) => {
    const stats = runtime.stats();
    const lines: string[] = [];

      const emitted = new Set<string>();

    for (const [providerName, p] of Object.entries(stats.providers)) {
      const labels = `{provider="${providerName}"}`;
      // Derived fields: queuedTotal and slotsUtilization used to live on
      // ProviderRuntimeStats as pre-computed properties; their inputs
      // (queuedInteractive, queuedBackground, active, maxConcurrent) are
      // what ProviderStateMap.snapshot() actually surfaces. Compute them
      // inline here so the gauge names stay stable for downstream
      // dashboards even though the runtime stats shape tightened. The
      // addition is constant-cost per provider (sub-microsecond) so a
      // /metrics scrape (typically every 15s) is unaffected.
      const queuedTotal = p.queuedInteractive + p.queuedBackground;
      const slotsUtilization = p.maxConcurrent > 0 ? p.active / p.maxConcurrent : 0;
      emitGauge(lines, emitted, "custos_throttle_active", labels, p.active);
      emitGauge(lines, emitted, "custos_throttle_queued_interactive", labels, p.queuedInteractive);
      emitGauge(lines, emitted, "custos_throttle_queued_background", labels, p.queuedBackground);
      emitGauge(lines, emitted, "custos_throttle_queued_total", labels, queuedTotal);
      emitGauge(lines, emitted, "custos_throttle_slots_utilization", labels, slotsUtilization);
      emitGauge(lines, emitted, "custos_throttle_max_concurrent", labels, p.maxConcurrent);
      // 1 when cooldown is active, 0 when not (or undefined). The gauge
      // name includes the binary state so a PromQL query like
      // `avg_over_time(custos_throttle_cooldown[5m]) > 0` catches
      // sustained cooling.
      emitGauge(lines, emitted, "custos_throttle_cooldown", labels, p.cooldownUntil ? 1 : 0);
    }

    reply.header("content-type", "text/plain; charset=utf-8");
    return reply.send(lines.join("\n") + "\n");
  });
}

/** Append one gauge metric line with its HELP and TYPE header, deduplicating
 *  the header pair via the `emitted` set keyed by metric name. */
function emitGauge(
  lines: string[],
  emitted: Set<string>,
  name: string,
  labels: string,
  value: number,
): void {
  if (!emitted.has(name)) {
    emitted.add(name);
    lines.push(`# HELP ${name} ${GAUGE_HELP[name]}`);
    lines.push(`# TYPE ${name} gauge`);
  }
  lines.push(`${name}${labels} ${value}`);
}
