// Integration test for the Prometheus /metrics endpoint.
// Spins up a minimal Fastify instance with a mock Runtime, calls GET /metrics,
// and asserts the response body contains the expected gauge names, label keys,
// and value types (integer or float) without actually running the server's
// full lifecycle (no config loading, no real provider wiring).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMetricsRoute } from "./metrics.js";
import type { Runtime, RuntimeStats, ProviderRuntimeStats } from "../runtime.js";

/** Build a minimal Runtime stub that returns the given stats snapshot
 *  without touching config, router, or disk. */
function stubRuntime(stats: RuntimeStats): Runtime {
  return { stats: () => stats } as unknown as Runtime;
}

describe("GET /metrics", () => {
  it("returns valid OpenMetrics with expected gauge names and labels", async () => {
    const app = Fastify({ logger: false });
    registerMetricsRoute(app, stubRuntime({
      providers: {
        ollama: {
          name: "ollama",
          active: 2,
          queuedInteractive: 5,
          queuedBackground: 3,
          queuedTotal: 8,
          maxConcurrent: 4,
          slotsUtilization: 0.5,
          rpmLimit: null,
          rateTokens: null,
          cooldownUntil: undefined,
        },
        anthropic: {
          name: "anthropic",
          active: 1,
          queuedInteractive: 0,
          queuedBackground: 0,
          queuedTotal: 0,
          maxConcurrent: 0,
          slotsUtilization: 0,
          rpmLimit: null,
          rateTokens: null,
          cooldownUntil: 1_700_000_000_000,
        },
      },
      timestamp: Date.now(),
    }));

    const res = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");

    const body = res.body;
    // Every expected gauge name appears at least once as a value line.
    for (const name of [
      "custos_throttle_active",
      "custos_throttle_queued_interactive",
      "custos_throttle_queued_background",
      "custos_throttle_queued_total",
      "custos_throttle_slots_utilization",
      "custos_throttle_max_concurrent",
      "custos_throttle_cooldown",
    ]) {
      assert.match(body, new RegExp(`^${name}\\{`, "m"), `${name} should appear as a gauge line`);
    }

    // HELP and TYPE headers appear once per metric name, not per provider.
    for (const name of [
      "custos_throttle_active",
      "custos_throttle_queued_interactive",
    ]) {
      const helpMatches = body.match(new RegExp(`^# HELP ${name} `, "gm"));
      assert.equal(helpMatches?.length, 1, `# HELP ${name} should appear exactly once`);
      const typeMatches = body.match(new RegExp(`^# TYPE ${name} gauge`, "gm"));
      assert.equal(typeMatches?.length, 1, `# TYPE ${name} gauge should appear exactly once`);
    }

    // Per-provider label keys are present.
    assert.match(body, /\{provider="ollama"\}/);
    assert.match(body, /\{provider="anthropic"\}/);

    // Cooldown: ollama has none (0), anthropic has one (1).
    assert.match(body, /^custos_throttle_cooldown\{provider="ollama"\} 0$/m, "ollama not on cooldown");
    assert.match(body, /^custos_throttle_cooldown\{provider="anthropic"\} 1$/m, "anthropic on cooldown");

    // Slots utilization is a float for ollama, 0 for anthropic (maxConcurrent=0 means not throttled).
    assert.match(body, /^custos_throttle_slots_utilization\{provider="ollama"\} 0\.5$/m);
    assert.match(body, /^custos_throttle_slots_utilization\{provider="anthropic"\} 0$/m);

    await app.close();
  });

  it("returns only a trailing newline when no providers are throttled", async () => {
    const app = Fastify({ logger: false });
    registerMetricsRoute(app, stubRuntime({
      providers: {},
      timestamp: Date.now(),
    }));

    const res = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "\n");
    await app.close();
  });
});
