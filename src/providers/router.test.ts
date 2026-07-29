// Pin ProviderRouter's per-instance priority resolution so the admin UI's
// new Priority field lands cleanly across the dispatch path.
//
// The full precedence chain (caller > instance > task default) is resolved
// per-entry inside completeWithEntries: pre-stamping merged.priority in
// complete() would lose the "did the caller actually set it?" signal,
// and the instance-level override wouldn't get a chance to win. These
// tests pin that contract from end to end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter, CircuitBreaker } from "./router.js";
import type { CompleteOptions, Priority, Provider, ProviderResponse } from "./types.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest, type TaskKind } from "../types.js";
import type { GatewayConfig, ProviderEntry } from "../config.js";
import type { SpendTracker } from "./spend-tracker.js";

const ZERO_REQ = {} as AnthropicMessagesRequest;
const OK_RESPONSE: ProviderResponse = { status: 200, headers: new Headers(), body: null };

/** Fake provider that records the priority it sees in `options.priority`
 * at each `complete()` invocation. The recorded order corresponds to
 * invocation order, not submission order, mirroring how the throttle tests
 * distinguish the two. */
function makePriorityRecordingProvider(name: string): { provider: Provider; invocations: string[] } {
  const invocations: string[] = [];
  const provider: Provider = {
    name,
    complete: (_req, options) => {
      invocations.push(options?.priority ?? "<unset>");
      return Promise.resolve(OK_RESPONSE);
    },
  };
  return { provider, invocations };
}

/** Minimal SpendTracker stub -- the router only ever calls
 * `isWithinBudget(name, budget)` on it. Returning true unconditionally
 * keeps the budget branch out of these tests' way. */
function makeAlwaysWithinBudget(): SpendTracker {
  return {
    isWithinBudget: async () => true,
  } as unknown as SpendTracker;
}

/** Build a router with one named instance whose config can vary per test.
 * The provider wiring is rebuilt from `providers[name]` so each test gets
 * a fresh invocation list. */
function buildRouter(
  instanceConfig: { priority?: Priority },
  providers: Record<string, Provider>,
  tasks: Partial<Record<TaskKind, ProviderEntry[]>>,
): { router: ProviderRouter; providers: Record<string, { provider: Provider; invocations: string[] }> } {
  const config: GatewayConfig = {
    openaiCompatibleInstances: {
      // The instance under test -- its priority is what we're exercising.
      inst: { baseUrl: "http://x", model: "m", ...instanceConfig },
    },
    embeddingProvider: { baseUrl: "http://x", model: "emb" },
    tasks: {
      general: [{ provider: "inst", priority: 1 }],
      permissionClassifier: [{ provider: "inst", priority: 1 }],
      memoryCurator: [{ provider: "inst", priority: 1 }],
      ...tasks,
    },
  };
  const recorded = Object.fromEntries(
    Object.keys(providers).map((k) => [k, { provider: providers[k], invocations: (providers[k] as unknown as { invocations: string[] }).invocations ?? [] }]),
  );
  const router = new ProviderRouter(providers, config, makeAlwaysWithinBudget());
  return { router, providers: recorded };
}

describe("ProviderRouter priority resolution", () => {
  it("task default applies when neither caller nor instance set priority", async () => {
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    // `general` task defaults to "interactive" in priorityForTask.
    await router.complete("general", ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "general task default is interactive");
  });

  it("memoryCurator task default is background when neither caller nor instance override", async () => {
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    await router.complete("memoryCurator", ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "memoryCurator task default is background");
  });

  it("instance priority overrides the task default", async () => {
    // Tag the instance as background, send a `general` request through
    // it -- task default says interactive, instance pins background, so
    // background wins. Same shape for memoryCurator would NOT flip the
    // answer (both sides say background); the converse (instance says
    // interactive, task says background) is what flips it -- tested next.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    await router.complete("general", ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "instance pinned background overrode task default interactive");
  });

  it("instance priority can flip a background-default task to interactive", async () => {
    // memoryCurator defaults to background. If the admin pinned the
    // instance as interactive, the dispatch should reflect the instance
    // config, not the task kind -- otherwise the per-instance UI control
    // would be inert for memoryCurator traffic.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "interactive" }, { inst: provider }, {});
    await router.complete("memoryCurator", ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "instance pinned interactive overrode memoryCurator's background default");
  });

  it("caller-supplied priority wins over both instance and task default", async () => {
    // Caller passes "background" explicitly. Instance is pinned
    // interactive, task is general (interactive). Caller should win.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "interactive" }, { inst: provider }, {});
    const callerOptions: CompleteOptions = { priority: "background" };
    await router.complete("general", ZERO_REQ, callerOptions);
    assert.deepEqual(invocations, ["background"], "caller priority wins over instance and task default");
  });

  it("caller-supplied priority wins over instance when both set, with memoryCurator task", async () => {
    // memoryCurator task default is background. Instance pinned
    // background. Caller passes interactive. Interactive wins.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    const callerOptions: CompleteOptions = { priority: "interactive" };
    await router.complete("memoryCurator", ZERO_REQ, callerOptions);
    assert.deepEqual(invocations, ["interactive"], "caller priority wins over instance priority and task default");
  });

  it("completeWithEntries (no task in scope) falls back to interactive when nothing else is set", async () => {
    // Complexity-tier routing calls completeWithEntries directly without
    // a task kind. The fallback (no caller, no instance, no task) must
    // be "interactive" so the historical behaviour for direct callers
    // holds.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    const entries: ProviderEntry[] = [{ provider: "inst", priority: 1 }];
    await router.completeWithEntries(entries, ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "completeWithEntries without a task falls back to interactive");
  });

  it("completeWithEntries honours instance priority when no task is in scope", async () => {
    // The per-instance override should apply whether or not a task kind
    // is in scope -- the task kind only contributes the *fallback*
    // value, not the lookup itself.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    const entries: ProviderEntry[] = [{ provider: "inst", priority: 1 }];
    await router.completeWithEntries(entries, ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "instance priority wins over the no-task fallback");
  });

  it("per-vendor cooldownFallbackMs applies when the upstream omits Retry-After", async () => {
    // Today a 429 with no Retry-After header falls through to the
    // router's global DEFAULT_COOLDOWN_MS (60s). For Gemini Free
    // quota-exhausted daily caps the upstream takes minutes to
    // recover, so a 60s default loops the gateway through 429s
    // mid-cooldown. The per-vendor override (cooldownFallbackMs on
    // ProviderDef) lets the operator set a value that matches the
    // upstream's actual recovery window without hand-editing the
    // router constant.
    const failingProvider: Provider = {
      name: "gemini-free",
      complete: async () => {
        throw new ProviderUnavailableError("gemini-free: HTTP 429"); // no retryAfterMs
      },
    };
    const okProvider: Provider = {
      name: "anthropic",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        "gemini-free": {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          costType: "free",
          models: [{ name: "gemini-2.0-flash-lite", enabled: true }],
          cooldownFallbackMs: 300_000, // 5 minutes — Gemini Free's typical cap-recovery window
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "gemini-free", priority: 1 }, { provider: "anthropic", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { "gemini-free": failingProvider, anthropic: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );
    await router.complete("general", ZERO_REQ);

    // The cooldown tracker must reflect the per-vendor fallback,
    // not the global 60s default.
    const cooldowns = router.cooldowns();
    assert.ok(cooldowns["gemini-free"] !== undefined, "gemini-free was marked unavailable");
    const remaining = cooldowns["gemini-free"] - Date.now();
    // ±500ms slack for the test-runner's wall-clock drift between
    // markUnavailable() and cooldowns().
    assert.ok(remaining > 299_500 && remaining <= 300_000,
      `expected ~300_000ms cooldown from cooldownFallbackMs, got ${remaining}ms (cooldown=${cooldowns["gemini-free"]}, now=${Date.now()})`);
  });

  it("upstream Retry-After header wins over cooldownFallbackMs when both are present", async () => {
    // Precedence: upstream Retry-After is the most accurate signal of
    // recovery time, and must override the per-vendor fallback. A
    // Gemini Free response with `Retry-After: 60` should produce a
    // 60s cooldown even when cooldownFallbackMs is set to 300_000.
    // The failing provider is paired with a fallback that succeeds so
    // the router exits the loop cleanly instead of throwing lastError.
    const failingProvider: Provider = {
      name: "gemini-free",
      complete: async () => {
        throw new ProviderUnavailableError("gemini-free: HTTP 429", 60_000);
      },
    };
    const okProvider: Provider = {
      name: "anthropic",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        "gemini-free": {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          costType: "free",
          models: [{ name: "gemini-2.0-flash-lite", enabled: true }],
          cooldownFallbackMs: 300_000,
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "gemini-free", priority: 1 }, { provider: "anthropic", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { "gemini-free": failingProvider, anthropic: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );
    await router.complete("general", ZERO_REQ);

    const cooldowns = router.cooldowns();
    const remaining = cooldowns["gemini-free"] - Date.now();
    assert.ok(remaining > 59_500 && remaining <= 60_000,
      `expected ~60_000ms cooldown from upstream Retry-After, got ${remaining}ms`);
  });

  it("global 60s default applies when no Retry-After AND no cooldownFallbackMs are set", async () => {
    // Backwards-compat: a provider without per-vendor config and without
    // an upstream Retry-After must continue using the router's global
    // default. Otherwise existing operator setups that don't set
    // cooldownFallbackMs would silently break. Pairs with a fallback
    // provider so the router exits cleanly without throwing lastError.
    const failingProvider: Provider = {
      name: "no-fallback",
      complete: async () => {
        throw new ProviderUnavailableError("no-fallback: HTTP 503"); // no retryAfterMs
      },
    };
    const okProvider: Provider = {
      name: "anthropic",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        "no-fallback": {
          baseUrl: "https://example.invalid/v1",
          costType: "metered",
          models: [{ name: "m", enabled: true }],
          // cooldownFallbackMs intentionally NOT set
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "no-fallback", priority: 1 }, { provider: "anthropic", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { "no-fallback": failingProvider, anthropic: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );
    await router.complete("general", ZERO_REQ);

    const cooldowns = router.cooldowns();
    const remaining = cooldowns["no-fallback"] - Date.now();
    assert.ok(remaining > 59_500 && remaining <= 60_000,
      `expected ~60_000ms cooldown from global default, got ${remaining}ms`);
  });

  it("circuit breaker: 5 consecutive failures trip the breaker with circuit-broken reason", async () => {
    // After 5 ProviderUnavailableError rejections within the 60s
    // sliding window, the breaker trips and the onUnavailable reason
    // switches from "upstream message" to "circuit-broken: 5
    // failures in 60s window (cooldown: Ns)". The cooldown duration
    // reflected in router.cooldowns() should equal the breaker's
    // BASE_COOLDOWN_MS (60s on the first trip).
    //
    // Wiring detail: the failing provider throws with retryAfterMs=0
    // so the regular cooldown is 0ms and each successive call still
    // hits the failing provider (otherwise the cooldown would skip
    // the provider on call 2). The fallback provider succeeds so
    // the router exits cleanly without throwing lastError.
    const failingProvider: Provider = {
      name: "gemini-free",
      complete: async () => {
        throw new ProviderUnavailableError("gemini-free: HTTP 429", 0);
      },
    };
    const okProvider: Provider = {
      name: "anthropic",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        "gemini-free": {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          costType: "free",
          models: [{ name: "gemini-2.0-flash-lite", enabled: true }],
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "gemini-free", priority: 1 }, { provider: "anthropic", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { "gemini-free": failingProvider, anthropic: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );
    const reasons: string[] = [];
    router.setAvailabilityListener({
      onUnavailable: (_name, _ms, reason) => reasons.push(reason),
      onAvailable: () => {},
    });

    // 4 failures should NOT trip the breaker -- reasons should still
    // be the raw upstream message ("gemini-free: HTTP 429"), not the
    // circuit-broken composite.
    for (let i = 0; i < 4; i++) {
      await router.complete("general", ZERO_REQ);
    }
    assert.equal(reasons.filter((r) => r.includes("circuit-broken")).length, 0,
      "no circuit-broken reason before the 5th failure");

    // 5th failure trips the breaker.
    await router.complete("general", ZERO_REQ);
    assert.equal(reasons.filter((r) => r.includes("circuit-broken")).length, 1,
      "5th failure should trip the breaker; reason string contains circuit-broken");

    // The breaker's first-trip cooldown is BASE_COOLDOWN_MS = 60s.
    const breakers = router.breakers();
    assert.ok(breakers["gemini-free"] !== undefined, "breaker deadline recorded for gemini-free");
    const breakerRemaining = breakers["gemini-free"] - Date.now();
    assert.ok(breakerRemaining > 59_500 && breakerRemaining <= 60_000,
      `expected ~60_000ms breaker cooldown on first trip, got ${breakerRemaining}ms`);

    // The regular cooldown tracker should also reflect the breaker
    // duration (so isAvailable() skips the provider for the full
    // breaker window).
    const cooldowns = router.cooldowns();
    assert.ok(cooldowns["gemini-free"] !== undefined, "regular cooldown tracker also reflects breaker duration");
  });

  it("circuit breaker: breaker duration overrides upstream Retry-After when longer", async () => {
    // Contract: when the breaker trips with a longer cooldown than
    // the upstream's Retry-After header, the breaker wins. This is
    // the whole point of the breaker -- the upstream's per-request
    // hint doesn't know about the gateway's accumulated signal that
    // "we've been hammering this provider", and a too-short hint
    // would re-trigger the 429 loop the breaker exists to break.
    //
    // Setup: failing provider throws with retryAfterMs=30s. The
    // breaker's BASE_COOLDOWN_MS is 60s, so once tripped the breaker
    // duration (60s) overrides the upstream hint (30s). The 5th
    // call should produce a cooldown closer to 60s than to 30s.
    const failingProvider: Provider = {
      name: "gemini-free",
      complete: async () => {
        throw new ProviderUnavailableError("gemini-free: HTTP 429", 30_000);
      },
    };
    const okProvider: Provider = {
      name: "anthropic",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        "gemini-free": {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          costType: "free",
          models: [{ name: "gemini-2.0-flash-lite", enabled: true }],
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "gemini-free", priority: 1 }, { provider: "anthropic", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { "gemini-free": failingProvider, anthropic: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );
    // 5 calls to trip the breaker.
    for (let i = 0; i < 5; i++) {
      await router.complete("general", ZERO_REQ);
    }
    const cooldowns = router.cooldowns();
    const remaining = (cooldowns["gemini-free"] ?? 0) - Date.now();
    // The breaker duration (60s) should override the upstream
    // Retry-After (30s). Allow ±2s slack for test-runner drift.
    assert.ok(remaining > 58_000 && remaining <= 60_000,
      `expected ~60_000ms cooldown (breaker overrides 30s upstream hint), got ${remaining}ms`);
  });

  it("circuit breaker: per-provider isolation (provider A trip doesn't affect provider B)", async () => {
    // Contract: the breaker state maps are per-provider; provider A
    // tripping has zero effect on provider B's breaker state, even
    // when both are called in the same request cycle.
    const failingProvider: Provider = {
      name: "failing",
      complete: async () => {
        throw new ProviderUnavailableError("failing: HTTP 429", 0);
      },
    };
    const okProvider: Provider = {
      name: "ok",
      complete: async () => OK_RESPONSE,
    };
    const config: GatewayConfig = {
      providers: {
        failing: { baseUrl: "x", costType: "metered", models: [{ name: "m", enabled: true }] },
        ok: { baseUrl: "x", costType: "metered", models: [{ name: "m", enabled: true }] },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "failing", priority: 1 }, { provider: "ok", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter(
      { failing: failingProvider, ok: okProvider },
      config,
      makeAlwaysWithinBudget(),
    );

    // Drive 5 failures on `failing` to trip its breaker. The
    // failover succeeds on `ok` for each call.
    for (let i = 0; i < 5; i++) {
      await router.complete("general", ZERO_REQ);
    }

    // `failing` is now circuit-broken. `ok` should have no breaker
    // entry -- its state is independent.
    const breakers = router.breakers();
    assert.ok(breakers["failing"] !== undefined, "failing's breaker tripped");
    assert.equal(breakers["ok"], undefined,
      "ok's breaker must be untouched even after 5 fails on failing");

    // A successful complete on `ok` should clear nothing for `failing`
    // -- but `ok`'s state stays clean regardless.
    await router.complete("general", ZERO_REQ);
    const breakersAfter = router.breakers();
    assert.ok(breakersAfter["failing"] !== undefined, "failing's breaker still tripped");
    assert.equal(breakersAfter["ok"], undefined, "ok still has no breaker entry");
  });

  it("circuit breaker: a success resets the consecutive-opens counter", async () => {
    // Drive 4 failures (still below the 5-failure threshold so the
    // breaker hasn't tripped), then a successful complete on the
    // fallback. The breaker's recent-failure list should be cleared
    // on the success path (recordSuccess is called for any successful
    // complete, even on a different provider than the one being
    // reset -- but here we want to verify the actual provider we
    // were failing on gets reset).
    //
    // Cleanest construction: a single provider that fails for the
    // first 4 calls then succeeds on the 5th. After the success,
    // the breaker's recent-failure list for that provider should be
    // empty, so 4 fresh failures must NOT trip the breaker (would
    // trip after 5, but we stop at 4 to confirm the reset).
    let calls = 0;
    const flippyProvider: Provider = {
      name: "flippy",
      complete: async () => {
        calls += 1;
        if (calls <= 4) {
          throw new ProviderUnavailableError("flippy: HTTP 429", 0);
        }
        return OK_RESPONSE;
      },
    };
    const config: GatewayConfig = {
      providers: {
        flippy: {
          baseUrl: "https://example.invalid/v1",
          costType: "metered",
          models: [{ name: "m", enabled: true }],
        },
      },
      openaiCompatibleInstances: {},
      tasks: {
        general: [{ provider: "flippy", priority: 1 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter({ flippy: flippyProvider }, config, makeAlwaysWithinBudget());

    for (let i = 0; i < 5; i++) {
      // 5th call succeeds; loop catches the throws so the test
      // doesn't stop at the first rejection.
      await router.complete("general", ZERO_REQ).catch(() => {});
    }
    assert.equal(calls, 5);

    // After the success on call 5, the breaker's recent-failure
    // list for flippy should be empty. 4 fresh failures must NOT
    // trip (would need 5). We can't directly inspect recentFailures,
    // but we CAN observe: 4 more failures (calls 6-9) keep the
    // breaker closed, and the onUnavailable reasons for those 4
    // calls should still be the raw upstream message (no
    // circuit-broken substring).
    const reasons: string[] = [];
    router.setAvailabilityListener({
      onUnavailable: (_n, _m, reason) => reasons.push(reason),
      onAvailable: () => {},
    });
    for (let i = 0; i < 4; i++) {
      await router.complete("general", ZERO_REQ).catch(() => {});
    }
    assert.equal(reasons.filter((r) => r.includes("circuit-broken")).length, 0,
      "after the success reset, 4 fresh failures should NOT trip the breaker");
  });
});

describe("CircuitBreaker (unit)", () => {
  // The unit tests construct CircuitBreaker directly with synthetic
  // clocks so we can verify exponential growth and the MAX_COOLDOWN_MS
  // cap without waiting real wall-clock seconds. Production code
  // creates the breaker inside ProviderRouter (private field); the
  // test-only export at the bottom of router.ts exposes the class
  // symbol specifically for this describe block.

  it("does not trip on fewer than 5 failures within the window", () => {
    const cb = new CircuitBreaker();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
      assert.equal(cb.recordFailure("p", now + i * 1000), undefined,
        `failure ${i + 1} should not trip the breaker`);
    }
    assert.equal(cb.isOpen("p", now + 4_000), false, "breaker stays closed below threshold");
  });

  it("trips on the 5th failure within the window", () => {
    const cb = new CircuitBreaker();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) cb.recordFailure("p", now + i * 1000);
    const deadline = cb.recordFailure("p", now + 4_000);
    assert.ok(deadline !== undefined, "5th failure must trip");
    assert.equal(deadline, now + 4_000 + CircuitBreaker.BASE_COOLDOWN_MS,
      `first-trip cooldown should be BASE_COOLDOWN_MS = ${CircuitBreaker.BASE_COOLDOWN_MS}`);
  });

  it("does not trip when 5 failures span beyond the 60s sliding window", () => {
    // 5 failures but the earliest one has aged out of the window by
    // the time the 5th arrives -- only the most recent 4 count.
    const cb = new CircuitBreaker();
    const now = 1_000_000;
    cb.recordFailure("p", now);
    cb.recordFailure("p", now + 20_000);
    cb.recordFailure("p", now + 40_000);
    cb.recordFailure("p", now + 60_000);
    const deadline = cb.recordFailure("p", now + 80_000);
    // Window math at the 5th call: cutoff = now+80_000 - 60_000 =
    // now+20_000. Pruning uses strict `<`, so failures with
    // timestamp < now+20_000 are dropped. `now` (80s old) is pruned;
    // `now+20_000` is at the cutoff and NOT pruned (boundary
    // inclusive). So 4 timestamps remain (now+20s, now+40s, now+60s,
    // now+80s) -- one below the threshold, so the breaker doesn't
    // trip. The assertion `deadline === undefined` is the load-bearing
    // contract here; the count math above is just explanation.
    assert.equal(deadline, undefined,
      `4 failures remain within the 60s window -- threshold not met, got deadline=${deadline}`);
  });

  it("grows cooldown exponentially on consecutive trips", () => {
    // Trip the breaker, advance the synthetic clock past the cooldown
    // deadline, trip again. The second trip's cooldown should be
    // 2 * BASE_COOLDOWN_MS, the third 4 * BASE_COOLDOWN_MS, etc.
    const cb = new CircuitBreaker();
    let now = 1_000_000;

    // Trip 1: 5 failures at now+0..400, breaker opens until now+500+BASE.
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    const trip1 = cb.recordFailure("p", now + 500);
    assert.equal(trip1, now + 500 + CircuitBreaker.BASE_COOLDOWN_MS,
      "first trip cooldown = BASE");

    // Advance past the cooldown (BASE + 1s slack).
    now = (trip1 ?? now) + 1_000;

    // Trip 2: 5 failures at now+0..400, breaker opens until now+500+2*BASE.
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    const trip2 = cb.recordFailure("p", now + 500);
    assert.equal(trip2, now + 500 + CircuitBreaker.BASE_COOLDOWN_MS * 2,
      "second trip cooldown = 2 * BASE");

    // Advance again.
    now = (trip2 ?? now) + 1_000;

    // Trip 3: cooldown should be 4 * BASE.
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    const trip3 = cb.recordFailure("p", now + 500);
    assert.equal(trip3, now + 500 + CircuitBreaker.BASE_COOLDOWN_MS * 4,
      "third trip cooldown = 4 * BASE");
  });

  it("caps cooldown at MAX_COOLDOWN_MS (30 minutes)", () => {
    // Trip the breaker many times. After enough trips, the cooldown
    // should saturate at MAX_COOLDOWN_MS instead of overflowing into
    // multi-hour outages.
    // 2^12 * BASE = 68h >> MAX_COOLDOWN_MS = 30min, so 12 trips is more
    // than enough to saturate the cap.
    const cb = new CircuitBreaker();
    let now = 5_000_000;
    for (let trip = 0; trip < 12; trip++) {
      for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
      // Advance past the cooldown to allow the next trip.
      // Use the previous deadline to advance cleanly.
      now += 100;
    }
    // After 12+ trips, the 13th trip should have cooldown = MAX_COOLDOWN_MS.
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    const finalDeadline = cb.recordFailure("p", now + 500);
    assert.equal(finalDeadline, now + 500 + CircuitBreaker.MAX_COOLDOWN_MS,
      `cooldown must cap at MAX_COOLDOWN_MS = ${CircuitBreaker.MAX_COOLDOWN_MS}, got ${finalDeadline}`);
  });

  it("recordSuccess resets the consecutive-opens counter (next trip at BASE_COOLDOWN_MS)", () => {
    const cb = new CircuitBreaker();
    let now = 6_000_000;

    // Trip once: openCount goes from 0 to 1 (because the trip itself
    // increments AFTER computing the cooldown). Actually re-read the
    // implementation: openCount is read, then cooldown computed, then
    // openCount incremented. So after the first trip, openCount = 1.
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    cb.recordFailure("p", now + 500);

    // Success -- resets the breaker state.
    cb.recordSuccess("p");

    // Advance past where any leftover cooldown would have been (the
    // trip we did set the cooldown for `now + 500 + BASE`, so we need
    // to advance past that).
    now += CircuitBreaker.BASE_COOLDOWN_MS + 1_000;

    // 5 fresh failures should trip at BASE (because success reset
    // consecutive-opens to 0).
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    const deadline = cb.recordFailure("p", now + 500);
    assert.equal(deadline, now + 500 + CircuitBreaker.BASE_COOLDOWN_MS,
      "after recordSuccess, the next trip cooldown should be BASE again");
  });

  it("snapshot filters out expired (already-OPEN-past-deadline) entries", () => {
    const cb = new CircuitBreaker();
    const now = 7_000_000;
    for (let i = 0; i < 5; i++) cb.recordFailure("p", now + i * 100);
    cb.recordFailure("p", now + 500);
    // At a time well past the breaker deadline, the snapshot should
    // not include `p` (it's no longer OPEN).
    const snapshot = cb.snapshot();
    assert.deepEqual(snapshot, [],
      `expected empty snapshot after the breaker deadline expired, got ${JSON.stringify(snapshot)}`);
  });
    // The router iterates entries and re-resolves priority per-entry
    // (each candidate gets a chance to contribute its own priority
    // before its request is dispatched). The first instance errors
    // (ProviderUnavailableError -> cooldown + continue), the second
    // instance -- with its own priority config -- should be tried with
    // ITS priority, not the first instance's.
  it("failover: when first instance errors, the per-entry priority resolution re-runs for the fallback", async () => {
    // The router iterates entries and re-resolves priority per-entry
    // (each candidate gets a chance to contribute its own priority
    // before its request is dispatched). The first instance errors
    // (ProviderUnavailableError -> cooldown + continue), the second
    // instance -- with its own priority config -- should be tried with
    // ITS priority, not the first instance's.
    const { provider: a, invocations: aInv } = makePriorityRecordingProvider("a");
    const { provider: b, invocations: bInv } = makePriorityRecordingProvider("b");
    // Override a's complete to throw ProviderUnavailableError once.
    let aCalls = 0;
    a.complete = async () => {
      aCalls += 1;
      aInv.push("would-have-been-sent");
      // Throwing ProviderUnavailableError triggers failover; the
      // cooldown tracker will skip `a` for subsequent calls.
      throw new ProviderUnavailableError("a: HTTP 429");
    };

    const config: GatewayConfig = {
      openaiCompatibleInstances: {
        a: { baseUrl: "http://a", model: "m", priority: "background" },
        b: { baseUrl: "http://b", model: "m", priority: "interactive" },
      },
      embeddingProvider: { baseUrl: "http://x", model: "emb" },
      tasks: {
        general: [{ provider: "a", priority: 1 }, { provider: "b", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
      },
    };
    const router = new ProviderRouter({ a, b }, config, makeAlwaysWithinBudget());
    await router.complete("general", ZERO_REQ);
    assert.equal(aCalls, 1, "first provider was attempted");
    assert.deepEqual(bInv, ["interactive"], "second provider saw its own priority, not the first instance's");
  });
});
