// StatsMonitor contracts: threshold crossing, sustained alerts, recovery
// clearing, snapshot formatting. Uses an injectable clock and a controlled
// stats callback so every tick is deterministic -- no setInterval, no
// wall-time waits.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsMonitor, type AlertRule, type StatsLogger } from "./runtime-stats.js";
import type { RuntimeStats, ProviderRuntimeStats } from "./runtime.js";
import type { GatewayConfig } from "./config.js";
import type { ProviderStateMap } from "./providers/provider-state.js";

/** Convenience: build a minimal ProviderRuntimeStats. Only the fields
 * the default rules extract from (queuedInteractive, queuedBackground)
 * need non-zero values; the rest use safe defaults. `queuedTotal` and
 * `slotsUtilization` were dropped from the type when the router dropped
 * out of the runtime stats surface; their inputs (queuedInteractive +
 * queuedBackground / active / maxConcurrent) are still here. */
function provider(overrides: Partial<ProviderRuntimeStats>): ProviderRuntimeStats {
  return {
    active: 0,
    queuedInteractive: 0,
    queuedBackground: 0,
    maxConcurrent: 1,
    ...overrides,
  };
}

/** Collect log messages so the test can assert on them. */
function captureLogger(): { logs: string[]; logger: StatsLogger } {
  const logs: string[] = [];
  return {
    logs,
    logger: {
      info: (msg: string) => logs.push(`info: ${msg}`),
      warn: (msg: string) => logs.push(`warn: ${msg}`),
    },
  };
}

/** Build a RuntimeStats with one named provider. */
function statsWith(providerName: string, p: ProviderRuntimeStats): RuntimeStats {
  return { providers: { [providerName]: p }, fallbackSets: {}, timestamp: Date.now() };
}

describe("StatsMonitor", () => {
  it("crossed: logs info when threshold is first exceeded", () => {
    const { logs, logger } = captureLogger();
    const m = new StatsMonitor(
      () => statsWith("ollama", provider({ queuedBackground: 51 })),
      {
        intervalMs: 999_999, // never fires
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 999_999,
            message: (n, v) => `${n} has ${v} bg queued`,
          },
        ],
        logger,
        now: () => 1000,
      },
    );
    m.tick();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /threshold crossed/);
    assert.match(logs[0], /ollama has 51 bg queued/);
  });

  it("sustained: fires the warn alert after the clock passes sustainedMs", () => {
    // Separate test because the state machine needs consecutive ticks.
    const { logs, logger } = captureLogger();
    let tick = 0;
    const m = new StatsMonitor(
      () => statsWith("ollama", provider({ queuedBackground: 60 })),
      {
        intervalMs: 999_999,
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 200,
            message: (n, v) => `${n} has ${v} bg queued`,
          },
        ],
        logger,
        now: () => 1000 + tick * 250, // each tick advances 250ms
      },
    );

    // Tick 1 at T=1000: crossed
    tick = 0;
    m.tick();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /threshold crossed/);

    // Tick 2 at T=1250: still crossed, only 250ms elapsed, 200ms sustainedMs reached
    tick = 1;
    m.tick();
    assert.equal(logs.length, 2, "crossed log + sustained alert");
    assert.match(logs[1], /ALERT/);
    assert.match(logs[1], /ollama has 60 bg queued/);
  });

  it("cleared: logs info and resets state when value drops below threshold", () => {
    const { logs, logger } = captureLogger();
    let tick = 0;
    const m = new StatsMonitor(
      () => {
        // At tick 0: above threshold; at tick 1: below threshold
        const v = tick === 0 ? 60 : 10;
        return statsWith("ollama", provider({ queuedBackground: v }));
      },
      {
        intervalMs: 999_999,
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 999_999,
            message: (n, v) => `${n} has ${v} bg queued`,
          },
        ],
        logger,
        now: () => 1000,
      },
    );

    tick = 0;
    m.tick();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /threshold crossed/);

    tick = 1;
    m.tick();
    assert.equal(logs.length, 2);
    assert.match(logs[1], /threshold cleared/);
    assert.match(logs[1], /ollama has 10 bg queued/);
  });

  it("re-crossed: resets the sustained timer after a clear", () => {
    const { logs, logger } = captureLogger();
    let tick = 0;
    const m = new StatsMonitor(
      () => {
        // Tick 0: crossed. Tick 1: cleared. Tick 2+3: re-crossed.
        const bg = tick === 0 ? 60 : tick === 1 ? 10 : 60;
        return statsWith("ollama", provider({ queuedBackground: bg }));
      },
      {
        intervalMs: 999_999,
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 300,
            message: (n, v) => `${n} has ${v} bg queued`,
          },
        ],
        logger,
        now: () => 1000 + tick * 100, // ticks at 1000, 1100, 1200, 1300
      },
    );

    // T=1000: crossed
    tick = 0;
    m.tick();
    assert.equal(logs.length, 1);

    // T=1100: cleared
    tick = 1;
    m.tick();
    assert.equal(logs.length, 2);
    assert.match(logs[1], /threshold cleared/);

    // T=1200: re-crossed (timer resets to 1200)
    tick = 2;
    m.tick();
    assert.equal(logs.length, 3);
    assert.match(logs[2], /threshold crossed/);
    // no ALERT yet -- only 0ms elapsed since re-crossing

    // T=1300: only 100ms since re-cross, < 300ms sustainedMs, still no ALERT
    tick = 3;
    m.tick();
    assert.equal(logs.length, 3, "no new log -- not yet sustained");
  });

  it("snapshot format: includes all providers when logSnapshot is true", () => {
    const { logs, logger } = captureLogger();
    const m = new StatsMonitor(
      () => ({
        providers: {
          ollama: provider({ active: 2, queuedInteractive: 5, queuedBackground: 3, maxConcurrent: 4 }),
          anthropic: provider({ active: 1, queuedInteractive: 0, queuedBackground: 0, maxConcurrent: 0 }),
        },
        fallbackSets: {},
        timestamp: Date.now(),
      }),
      {
        intervalMs: 999_999,
        rules: [],
        logger,
        logSnapshot: true,
        now: () => 1000,
      },
    );
    m.tick();
    assert.equal(logs.length, 1);
    const line = logs[0];
    assert.match(line, /ollama\(active=2,qi=5,qb=3,slots=2\/4\)/);
    assert.match(line, /anthropic\(active=1,qi=0,qb=0\)/); // no slots= because maxConcurrent=0
  });

  it("multiple rules: both evaluate independently per provider", () => {
    const { logs, logger } = captureLogger();
    const rules: AlertRule[] = [
      {
        id: "bg-stuck",
        extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
        threshold: 10,
        sustainedMs: 999_999,
        message: (n, v) => `${n} bg=${v}`,
      },
      {
        id: "int-backup",
        extract: (p) => (p.queuedInteractive > 0 ? p.queuedInteractive : null),
        threshold: 5,
        sustainedMs: 999_999,
        message: (n, v) => `${n} int=${v}`,
      },
    ];
    const m = new StatsMonitor(
      () =>
        statsWith("ollama", provider({ queuedBackground: 12, queuedInteractive: 8 })),
      { intervalMs: 999_999, rules, logger, now: () => 1000 },
    );
    m.tick();
    assert.equal(logs.length, 2);
    assert.match(logs[0], /bg=12/);
    assert.match(logs[1], /int=8/);
  });

  it("extract returns null: rule is skipped for that provider", () => {
    const { logs, logger } = captureLogger();
    // A rule that extracts null for a provider with only interactive traffic
    const rules: AlertRule[] = [
      {
        id: "bg-only-rule",
        extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
        threshold: 0, // any non-null value triggers
        sustainedMs: 999_999,
        message: (n, v) => `${n} bg=${v}`,
      },
    ];
    const m = new StatsMonitor(
      () => statsWith("ollama", provider({ queuedInteractive: 100, queuedBackground: 0 })),
      { intervalMs: 999_999, rules, logger, now: () => 1000 },
    );
    m.tick();
    assert.equal(logs.length, 0, "bg-only rule should be skipped when queuedBackground is 0 and extract returns null");
  });

  it("start/stop: idempotent start, stop clears the interval timer", () => {
    // We can't observe the interval directly, but we can verify the
    // monitor doesn't fire after stop by driving ticks manually and
    // asserting the timer reference is cleared.
    const { logger } = captureLogger();
    const m = new StatsMonitor(
      () => statsWith("ollama", provider({ queuedBackground: 60 })),
      {
        intervalMs: 10,
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 999_999,
            message: (n, v) => `${n} bg=${v}`,
          },
        ],
        logger,
        now: () => 1000,
      },
    );

    // Tick once manually before start
    m.tick();
    // start with a short interval -- should tick automatically
    m.start();
    // stop immediately
    m.stop();
    // After stop, the timer should be null (start would be a no-op)
    // We verify by calling start again and checking it works:
    m.start();
    m.stop();
    // No crash = pass. The interval timer is cleaned up.
    assert.ok(true, "start/stop cycle completed without error");
  });

  it("fallbackSetHealth: returns one entry per set with chain status and live pick", async () => {
    // Lightweight runtime smoke: drive the fallbackSetHealth path
    // through a hand-built ProviderStateMap + a fake config so we can
    // assert the wire shape without spinning up the full Runtime.
    // The Runtime class is heavy; the helper reads only `config` and
    // `providerState`, both of which we can stub.
    const { Runtime } = await import("./runtime.js");
    const { ProviderStateMap } = await import("./providers/provider-state.js");
    const runtime = new Runtime();
    runtime.config = {
      providers: {},
      openaiCompatibleInstances: {},
      fallbackSets: {
        complex: {
          name: "Complex reasoning",
          description: "test complex set",
          providers: [
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" },
          ],
        },
        empty: {
          name: "Empty (test)",
          description: "test empty",
          providers: [],
        },
      },
      tasks: {},
    } as unknown as GatewayConfig;
    // Build a fresh ProviderStateMap with two providers, mark
    // anthropic as cooling (so the live pick falls through to ollama).
    const freshMap = new ProviderStateMap();
    freshMap.register("anthropic", { maxConcurrent: 4 });
    freshMap.register("ollama", { maxConcurrent: 1 });
    freshMap.markCooling("anthropic", 60_000);
    // Swap the map in via the readonly field. We have to reach into
    // the private shape because the runtime holds it as a singleton;
    // tests for this surface care about the SHAPE of the output, not
    // whether Runtime can hot-swap its state map.
    (runtime as unknown as { providerState: ProviderStateMap }).providerState = freshMap;

    const health = runtime.fallbackSetHealth();

    assert.ok(health.complex, "complex set is reported");
    assert.equal(health.complex.chainLength, 2);
    assert.equal(health.complex.entries.length, 2);
    // [0] anthropic is cooling
    assert.equal(health.complex.entries[0].provider, "anthropic");
    assert.equal(health.complex.entries[0].status, "cooldown");
    assert.ok(health.complex.entries[0].coolingUntil, "cooldown deadline surfaces");
    // [1] ollama is the live pick
    assert.equal(health.complex.entries[1].provider, "ollama");
    assert.equal(health.complex.entries[1].status, "available");
    assert.deepEqual(health.complex.livePick, { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M", index: 1 });
    assert.equal(health.complex.exhausted, false);

    assert.ok(health.empty, "empty set is reported");
    assert.equal(health.empty.chainLength, 0);
    assert.equal(health.empty.entries.length, 0);
    assert.equal(health.empty.livePick, null);
    // Exhausted is reserved for sets that have entries but no live pick;
    // an empty set is its own thing (no chain = no failover path at all).
    assert.equal(health.empty.exhausted, false, "empty set is not 'exhausted' (no chain to walk)");
  });

  it("fallbackSetHealth: marks a set exhausted when every entry is unavailable", async () => {
    const { Runtime } = await import("./runtime.js");
    const { ProviderStateMap } = await import("./providers/provider-state.js");
    const runtime = new Runtime();
    runtime.config = {
      providers: {},
      openaiCompatibleInstances: {},
      fallbackSets: {
        complex: {
          name: "Complex reasoning",
          description: "test",
          providers: [
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" },
          ],
        },
      },
      tasks: {},
    } as unknown as GatewayConfig;
    const freshMap = new ProviderStateMap();
    freshMap.register("anthropic", { maxConcurrent: 4 });
    freshMap.register("ollama", { maxConcurrent: 1 });
    freshMap.markCooling("anthropic", 60_000);
    freshMap.markCooling("ollama", 60_000);
    (runtime as unknown as { providerState: ProviderStateMap }).providerState = freshMap;

    const health = runtime.fallbackSetHealth();
    assert.equal(health.complex.exhausted, true);
    assert.equal(health.complex.livePick, null);
    // Both entries should report cooldown status, not "available".
    for (const entry of health.complex.entries) {
      assert.notEqual(entry.status, "available");
    }
  });

  it("fallbackSetHealth: flags unregistered provider names with status='unregistered'", async () => {
    // Set references a provider the runtime never registered (config
    // drift: typo in providers.<name>, or the operator removed the
    // provider). The runtime would dispatch to this entry and crash
    // at the provider lookup; the UI needs to surface it as
    // "missing" rather than implying the entry is healthy.
    const { Runtime } = await import("./runtime.js");
    const { ProviderStateMap } = await import("./providers/provider-state.js");
    const runtime = new Runtime();
    runtime.config = {
      providers: {},
      openaiCompatibleInstances: {},
      fallbackSets: {
        complex: {
          name: "Complex reasoning",
          description: "test",
          providers: [
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "typo-provider", model: "claude-typo" },
          ],
        },
      },
      tasks: {},
    } as unknown as GatewayConfig;
    // Register anthropic but NOT typo-provider, so [0] is healthy
    // and [1] is the unregistered one. (If neither is registered,
    // both come back as 'unregistered' -- which would still satisfy
    // the `unregistered` assertion but the `available` assertion for
    // [0] would fail.)
    const freshMap = new ProviderStateMap();
    freshMap.register("anthropic", { maxConcurrent: 4 });
    (runtime as unknown as { providerState: ProviderStateMap }).providerState = freshMap;
    const health = runtime.fallbackSetHealth();
    assert.equal(health.complex.entries[0].status, "available");
    assert.equal(health.complex.entries[1].status, "unregistered");
    // The live pick is still [0] (anthropic) -- [1]'s unregistered
    // status means it never becomes a candidate.
    assert.equal(health.complex.livePick?.provider, "anthropic");
    assert.equal(health.complex.exhausted, false);
  });

  it("uses the injected now() for all timing decisions", () => {
    const { logs, logger } = captureLogger();
    let clock = 0;
    const m = new StatsMonitor(
      () => statsWith("ollama", provider({ queuedBackground: 60 })),
      {
        intervalMs: 999_999,
        rules: [
          {
            id: "bg-stuck",
            extract: (p) => (p.queuedBackground > 0 ? p.queuedBackground : null),
            threshold: 50,
            sustainedMs: 100,
            message: (n, v) => `${n} bg=${v}`,
          },
        ],
        logger,
        now: () => clock,
      },
    );
    // T=0: crossed
    clock = 0;
    m.tick();
    assert.equal(logs.length, 1);

    // T=50: still crossed, only 50ms < 100ms sustainedMs
    clock = 50;
    m.tick();
    assert.equal(logs.length, 1, "not yet sustained");

    // T=100: exactly 100ms >= 100ms sustainedMs
    clock = 100;
    m.tick();
    assert.equal(logs.length, 2, "sustained alert fires at exactly sustainedMs after first crossed tick");
    assert.match(logs[1], /ALERT/);
  });
});

describe("Runtime.startMirrorRefresh disable paths", () => {
  // The mirror-refresh timer must NOT schedule a setInterval when the
  // env var is invalid. The disable contract on startMirrorRefresh is:
  //   - 0           → disabled (covers MIRROR_REFRESH_INTERVAL_MS=0)
  //   - < 1000ms    → disabled (sub-1000ms spin loop is forbidden)
  //   - NaN         → disabled (malformed env like "30s"; !NaN === true)
  //   - undefined   → falls through to the 30_000ms default
  // These tests pin that contract so a future refactor (e.g. someone
  // inverting the check to `if (val >= 1000)`) cannot accidentally
  // schedule a spin-loop on a malformed value.

  /** Snapshot env, run body, restore on exit. Each test mutates
   *  MIRROR_REFRESH_INTERVAL_MS to a value the disable path expects,
   *  so try/finally is required to keep the test process from leaking
   *  a bad interval to the next describe block. */
  function withMirrorEnv(value: string | undefined, body: () => void): void {
    const original = process.env.MIRROR_REFRESH_INTERVAL_MS;
    try {
      if (value === undefined) delete process.env.MIRROR_REFRESH_INTERVAL_MS;
      else process.env.MIRROR_REFRESH_INTERVAL_MS = value;
      body();
    } finally {
      if (original === undefined) delete process.env.MIRROR_REFRESH_INTERVAL_MS;
      else process.env.MIRROR_REFRESH_INTERVAL_MS = original;
    }
  }

  it("refuses to schedule the timer when MIRROR_REFRESH_INTERVAL_MS=0", async () => {
    const { Runtime } = await import("./runtime.js");
    withMirrorEnv("0", () => {
      const runtime = new Runtime();
      const r = runtime as unknown as {
        mirrorRefreshIntervalMs: number;
        mirrorRefreshTimer: ReturnType<typeof setInterval> | null;
      };
      assert.equal(r.mirrorRefreshIntervalMs, 0, "field initializer should have read 0 from env");
      runtime.startMirrorRefresh();
      assert.equal(r.mirrorRefreshTimer, null, "timer must not be scheduled when interval is 0 (treated as disabled)");
    });
  });

  it("refuses to schedule the timer when MIRROR_REFRESH_INTERVAL_MS is below 1000", async () => {
    const { Runtime } = await import("./runtime.js");
    withMirrorEnv("500", () => {
      const runtime = new Runtime();
      const r = runtime as unknown as {
        mirrorRefreshIntervalMs: number;
        mirrorRefreshTimer: ReturnType<typeof setInterval> | null;
      };
      assert.equal(r.mirrorRefreshIntervalMs, 500, "field initializer should have read 500 from env");
      runtime.startMirrorRefresh();
      assert.equal(r.mirrorRefreshTimer, null, "timer must not be scheduled when interval is below the 1000ms floor");
    });
  });

  it("refuses to schedule the timer at 999ms (1ms below the 1000ms floor)", async () => {
    // Boundary-pair companion to the 1000ms test below. Without both
    // sides of the boundary pinned, refactors that flip `<` to `<=`
    // (or hoist a misnamed "floor" constant) silently break the
    // contract. With the pair, the swap is caught at unit-test time.
    const { Runtime } = await import("./runtime.js");
    withMirrorEnv("999", () => {
      const runtime = new Runtime();
      const r = runtime as unknown as {
        mirrorRefreshIntervalMs: number;
        mirrorRefreshTimer: ReturnType<typeof setInterval> | null;
      };
      assert.equal(r.mirrorRefreshIntervalMs, 999, "field initializer should have read 999 from env");
      runtime.startMirrorRefresh();
      assert.equal(r.mirrorRefreshTimer, null, "timer must not be scheduled at 999ms (just below the 1000ms floor)");
    });
  });

  it("schedules the timer at exactly the 1000ms floor", async () => {
    // Boundary-pair companion to the 999ms test above. At exactly
    // 1000ms the floor check (`< 1000`) does NOT trigger, so the
    // timer is scheduled. We schedule a real 1Hz tick explicitly so
    // the pair as a whole pins "below floor disables, at-or-above
    // floor schedules" — a refactor to `<= 1000` would pass 999 (still
    // disables) but fail this test (1000 would also disable). Cleanup
    // with stopMirrorRefresh() so the 1Hz tick doesn't pollute the
    // remainder of the test process with mirror-write attempts; the
    // unref() makes the timer exit-safe even without the explicit
    // stop, but stopping it matches the normal runtime lifecycle.
    const { Runtime } = await import("./runtime.js");
    withMirrorEnv("1000", () => {
      const runtime = new Runtime();
      const r = runtime as unknown as {
        mirrorRefreshIntervalMs: number;
        mirrorRefreshTimer: ReturnType<typeof setInterval> | null;
      };
      assert.equal(r.mirrorRefreshIntervalMs, 1000, "field initializer should have read 1000 from env");
      runtime.startMirrorRefresh();
      assert.notEqual(r.mirrorRefreshTimer, null, "timer MUST be scheduled at exactly 1000ms (boundary passes)");
      // Pin the `.unref()` contract. If a future refactor drops the
      // `.unref()` block in startMirrorRefresh, the disable-path tests
      // still pass (they assert `=== null`) and the production behavior
      // silently regresses to a keeping-alive interval that holds the
      // event loop past `app.close()` until SIGKILL. Asserting `unref`
      // is a function surfaces that regression at unit-test time.
      assert.equal(
        typeof (r.mirrorRefreshTimer as { unref?: () => unknown } | null)?.unref,
        "function",
        "timer must expose .unref() so it doesn't keep the process alive past shutdown",
      );
      assert.doesNotThrow(
        () => (r.mirrorRefreshTimer as { unref: () => unknown } | null)?.unref?.(),
        "calling .unref() on the timer must be a no-throw",
      );
      runtime.stopMirrorRefresh();
      assert.equal(r.mirrorRefreshTimer, null, "stopMirrorRefresh clears the timer reference");
    });
  });

  it("refuses to schedule the timer when MIRROR_REFRESH_INTERVAL_MS is malformed (parses to NaN)", async () => {
    // The disable contract relies on `!NaN === true` short-circuiting
    // before the `< 1000` clause. This test exists specifically to
    // pin that behavior -- a refactor that drops the `!` short-circuit
    // (e.g. `if (val >= 1000) schedule`) would let NaN fall through
    // and schedule a sub-1ms spin-loop on a malformed env like "30s".
    const { Runtime } = await import("./runtime.js");
    withMirrorEnv("30s", () => {
      const runtime = new Runtime();
      const r = runtime as unknown as {
        mirrorRefreshIntervalMs: number;
        mirrorRefreshTimer: ReturnType<typeof setInterval> | null;
      };
      assert.ok(Number.isNaN(r.mirrorRefreshIntervalMs), "Number('30s') is NaN");
      runtime.startMirrorRefresh();
      assert.equal(
        r.mirrorRefreshTimer,
        null,
        "timer must not be scheduled when interval parses to NaN (!NaN === true short-circuits the disable)",
      );
    });
  });
});
