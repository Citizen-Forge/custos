// ProviderStateMap contracts.
//
// The global provider state map is the single source of truth for whether
// each provider can accept a request right now. These tests pin every gate
// (cooldown, circuit breaker, concurrency, RPM) and the acquire/release
// lifecycle so the fallback-aware GlobalQueue and the router's availability
// checks share one set of assumptions.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ProviderStateMap } from "./provider-state.js";

/** Advance the clock by faking Date.now(). All ProviderStateMap code
 * paths that read the wall clock go through Date.now() so this is safe. */
function advanceMs(ms: number): void {
  const orig = Date.now;
  const fake = orig() + ms;
  Date.now = () => fake;
}

function resetClock(): void {
  Date.now = () => origNow;
}

let origNow: number;

before(() => {
  origNow = Date.now();
});

after(() => {
  Date.now = () => origNow;
});

describe("ProviderStateMap", () => {
  // -- register / unregister --------------------------------------------------

  it("register creates an entry with default values", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    const e = m.get("ollama");
    assert.ok(e, "entry should exist after register");
    assert.equal(e.coolingUntil, null);
    assert.equal(e.breakerUntil, null);
    assert.equal(e.maxConcurrent, 0);
    assert.equal(e.active, 0);
    assert.equal(e.queued, 0);
    assert.equal(e.rpmLimit, null);
    assert.equal(e.cooldownFallbackMs, null);
  });

  it("register accepts init options", () => {
    const m = new ProviderStateMap();
    m.register("gemini", { maxConcurrent: 2, rpmLimit: 10, cooldownFallbackMs: 300_000 });
    const e = m.get("gemini");
    assert.ok(e);
    assert.equal(e.maxConcurrent, 2);
    assert.equal(e.rpmLimit, 10);
    assert.equal(e.rpmTokens, 10);
    assert.equal(e.cooldownFallbackMs, 300_000);
  });

  it("register is idempotent — updates settings but preserves live counters", () => {
    const m = new ProviderStateMap();
    m.register("ollama", { maxConcurrent: 1 });

    // Acquire a slot so active=1
    const release = m.acquire("ollama");
    assert.equal(m.get("ollama")!.active, 1);

    // Re-register with a higher maxConcurrent — active must stay at 1.
    m.register("ollama", { maxConcurrent: 3 });
    assert.equal(m.get("ollama")!.maxConcurrent, 3);
    assert.equal(m.get("ollama")!.active, 1, "active counter preserved across re-register");

    release();
    assert.equal(m.get("ollama")!.active, 0);
  });

  it("unregister removes the provider from the map", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    m.unregister("ollama");
    assert.equal(m.get("ollama"), undefined);
    assert.deepEqual(m.names, []);
  });

  it("names returns all registered provider names", () => {
    const m = new ProviderStateMap();
    m.register("a");
    m.register("b");
    m.register("c");
    assert.deepEqual(m.names.sort(), ["a", "b", "c"]);
  });

  // -- canAccept gates --------------------------------------------------------

  it("canAccept returns false for an unregistered provider", () => {
    const m = new ProviderStateMap();
    assert.equal(m.canAccept("nonexistent"), false);
  });

  it("canAccept returns true when all gates pass (unlimited)", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    assert.equal(m.canAccept("ollama"), true);
  });

  it("canAccept false: cooldown gate", () => {
    const m = new ProviderStateMap();
    m.register("gemini");
    m.markCooling("gemini", 10_000);
    // coolingUntil is set to now + 10s; now is still origNow, so the gate trips.
    assert.equal(m.canAccept("gemini"), false, "cooling provider should be rejected");
  });

  it("canAccept true: cooldown expired", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    m.markCooling("ollama", 5_000);

    // Advance past the cooldown window.
    advanceMs(10_000);
    assert.equal(m.canAccept("ollama"), true, "cooldown expired — should accept");
    resetClock();
  });

  it("canAccept false: circuit breaker gate", () => {
    const m = new ProviderStateMap();
    m.register("gemini");
    // Trip the breaker with 5 failures
    for (let i = 0; i < 5; i++) m.recordFailure("gemini");
    assert.equal(m.canAccept("gemini"), false, "circuit-broken provider should be rejected");
  });

  it("canAccept true: circuit breaker expired", () => {
    const m = new ProviderStateMap();
    m.register("gemini");
    for (let i = 0; i < 5; i++) m.recordFailure("gemini");

    // Advance past the 60s breaker window.
    advanceMs(70_000);
    assert.equal(m.canAccept("gemini"), true, "breaker expired — should accept");
    resetClock();
  });

  it("canAccept false: concurrency gate (0 = unlimited)", () => {
    const m = new ProviderStateMap();
    m.register("ollama", { maxConcurrent: 1 });
    const release = m.acquire("ollama"); // now active=1

    assert.equal(m.canAccept("ollama"), false, "at maxConcurrent cap — should reject");

    release();
    assert.equal(m.canAccept("ollama"), true, "slot released — should accept");
  });

  it("canAccept with maxConcurrent=0 treats it as unlimited", () => {
    const m = new ProviderStateMap();
    m.register("unlimited", { maxConcurrent: 0 });
    assert.equal(m.canAccept("unlimited"), true);

    // Even with one active, we can still accept because 0 = unlimited.
    const r1 = m.acquire("unlimited");
    assert.equal(m.canAccept("unlimited"), true);
    const r2 = m.acquire("unlimited");
    assert.equal(m.canAccept("unlimited"), true);
    r1();
    r2();
  });

  it("canAccept false: RPM gate", () => {
    const m = new ProviderStateMap();
    m.register("gemini", { rpmLimit: 1 });
    const release = m.acquire("gemini"); // consumes the only token
    assert.equal(m.canAccept("gemini"), false, "no RPM tokens — should reject");
    release();
  });

  it("canAccept true: RPM tokens refilled", () => {
    const m = new ProviderStateMap();
    m.register("gemini", { rpmLimit: 1 });
    const release = m.acquire("gemini"); // token consumed

    // Advance past the refill window — 60s gives a full token back.
    advanceMs(60_001);
    assert.equal(m.canAccept("gemini"), true, "tokens refilled — should accept");
    resetClock();
    release();
  });

  it("canAccept passes all gates simultaneously", () => {
    const m = new ProviderStateMap();
    m.register("healthy", { maxConcurrent: 5, rpmLimit: 100 });
    assert.equal(m.canAccept("healthy"), true);
  });

  // -- acquire / release ------------------------------------------------------

  it("acquire throws for an unregistered provider", () => {
    const m = new ProviderStateMap();
    assert.throws(() => m.acquire("ghost"), /is not registered/);
  });

  it("acquire increments active and consumes an RPM token", () => {
    const m = new ProviderStateMap();
    m.register("limited", { maxConcurrent: 3, rpmLimit: 10 });
    const initialTokens = m.get("limited")!.rpmTokens;

    const release = m.acquire("limited");
    const entry = m.get("limited")!;
    assert.equal(entry.active, 1);
    assert.equal(entry.rpmTokens, initialTokens - 1);

    release();
    assert.equal(entry.active, 0);
  });

  it("acquire returns a release function that decrements active", () => {
    const m = new ProviderStateMap();
    m.register("ollama", { maxConcurrent: 2 });
    const r1 = m.acquire("ollama");
    const r2 = m.acquire("ollama");
    assert.equal(m.get("ollama")!.active, 2);

    r1();
    assert.equal(m.get("ollama")!.active, 1);
    r2();
    assert.equal(m.get("ollama")!.active, 0);
  });

  it("release is idempotent — multiple calls don't drive active negative", () => {
    const m = new ProviderStateMap();
    m.register("safe", { maxConcurrent: 1 });
    const r = m.acquire("safe");
    assert.equal(m.get("safe")!.active, 1);
    r();
    assert.equal(m.get("safe")!.active, 0);
    r(); // second release — should be harmless
    assert.equal(m.get("safe")!.active, 0);
  });

  // -- markCooling ------------------------------------------------------------

  it("markCooling sets coolingUntil using retryAfterMs", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    m.markCooling("ollama", 30_000);
    const entry = m.get("ollama")!;
    assert.ok(entry.coolingUntil !== null);
    // coolingUntil should be origNow + 30s (with at least 1s floor)
    assert.ok(entry.coolingUntil >= origNow + 30_000);
  });

  it("markCooling uses fallbackMs when retryAfterMs is undefined", () => {
    const m = new ProviderStateMap();
    m.register("gemini", { cooldownFallbackMs: 300_000 });
    m.markCooling("gemini", undefined, 300_000);
    const entry = m.get("gemini")!;
    assert.ok(entry.coolingUntil !== null);
    assert.ok(entry.coolingUntil >= origNow + 300_000);
  });

  it("markCooling is a no-op when both retryAfterMs and fallbackMs are null", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    m.markCooling("ollama", null, null);
    assert.equal(m.get("ollama")!.coolingUntil, null);
  });

  it("markCooling is a no-op for an unregistered provider", () => {
    const m = new ProviderStateMap();
    m.markCooling("ghost", 10_000); // should not throw
  });

  it("markCooling enforces a 1-second minimum", () => {
    const m = new ProviderStateMap();
    m.register("fast", { cooldownFallbackMs: 100 });
    m.markCooling("fast", null, 100);
    const entry = m.get("fast")!;
    // Should be at least origNow + 1000 (the 1s floor), not +100.
    assert.ok(entry.coolingUntil !== null);
    assert.ok(entry.coolingUntil >= origNow + 1000);
  });

  // -- circuit breaker sliding window -----------------------------------------

  it("recordFailure returns null for an unregistered provider", () => {
    const m = new ProviderStateMap();
    assert.equal(m.recordFailure("ghost"), null, "unregistered provider should not trip breaker");
  });

  it("recordFailure returns null below the threshold", () => {
    const m = new ProviderStateMap();
    m.register("resilient");
    const r = m.recordFailure("resilient");
    assert.equal(r, null, "under-threshold failures should not trip the breaker");
  });

  it("recordFailure trips the breaker at the threshold (5 failures)", () => {
    const m = new ProviderStateMap();
    m.register("breaker");
    let deadline: number | null = null;
    for (let i = 0; i < 5; i++) {
      deadline = m.recordFailure("breaker");
    }
    assert.ok(deadline !== null, "5th failure should trip the breaker");
    // Deadline should be origNow + 60s (base cooldown)
    assert.ok(deadline >= origNow + 60_000);
  });

  it("recordFailure sliding window prunes old failures", () => {
    const m = new ProviderStateMap();
    m.register("sliding");

    // 4 failures at time=0.
    for (let i = 0; i < 4; i++) m.recordFailure("sliding");

    // The first 4 should not trip.
    let deadline = m.recordFailure("sliding"); // 5th at time=0
    assert.ok(deadline !== null, "5th failure should trip at time=0");

    // Advance past the breaker window so the breaker expires.
    advanceMs(120_000);
    // The breaker expired — canAccept passes again.
    assert.equal(m.canAccept("sliding"), true, "breaker expired");

    // Now record 5 more failures at the advanced time. The old failures
    // (at time=0) are outside the 60s window and should be pruned.
    for (let i = 0; i < 4; i++) m.recordFailure("sliding");
    deadline = m.recordFailure("sliding"); // 5th at advanced time, after pruning
    assert.ok(deadline !== null, "5th failure after window expiry should re-trip");

    resetClock();
  });

  it("recordFailure exponential backoff on consecutive trips without clearing", () => {
    const m = new ProviderStateMap();
    m.register("exp-backoff");

    // Trip 1 — 5 failures, openCount=0, cooldown=60s
    for (let i = 0; i < 5; i++) m.recordFailure("exp-backoff");
    const trip1 = m.get("exp-backoff")!.breakerUntil;
    assert.ok(trip1 !== null);
    assert.ok(trip1 >= origNow + 60_000, "first trip: 60s");
    assert.ok(trip1 < origNow + 70_000, "first trip: ~60s");

    // After trip 1, consecutiveOpens=1. The 6th failure (still within
    // the same 60s window) re-trips with openCount=1 → cooldown=120s.
    // We record only ONE more failure — re-breaking 5 more times
    // would rapidly hit the 30min MAX cap.
    m.recordFailure("exp-backoff");
    const trip2 = m.get("exp-backoff")!.breakerUntil;
    assert.ok(trip2 !== null);
    // trip2 should be now + 120s (60s * 2^1 = 120s). Allow 1s slop.
    assert.ok(trip2 >= origNow + 120_000, `second trip should be ~120s, got ${trip2 - origNow}ms`);
    assert.ok(trip2 < origNow + 130_000, `second trip capped at ~120s, got ${trip2 - origNow}ms`);
  });

  it("recordFailure caps at MAX_MS (30min)", () => {
    const m = new ProviderStateMap();
    m.register("capped");

    // Trip enough times to exceed the cap.
    for (let trip = 0; trip < 10; trip++) {
      m.clearFailures("capped");
      for (let i = 0; i < 5; i++) m.recordFailure("capped");
    }

    const entry = m.get("capped")!;
    assert.ok(entry.breakerUntil !== null);
    // breakerUntil is an epoch timestamp; compare against (now + 30min)
    assert.ok(entry.breakerUntil <= origNow + 30 * 60 * 1000 + 1000, "breaker capped at 30 minutes");
  });

  it("recordSuccess clears breakerUntil", () => {
    const m = new ProviderStateMap();
    m.register("recovering");
    for (let i = 0; i < 5; i++) m.recordFailure("recovering");
    assert.ok(m.get("recovering")!.breakerUntil !== null);

    m.recordSuccess("recovering");
    assert.equal(m.get("recovering")!.breakerUntil, null);
  });

  // -- queue depth counters ---------------------------------------------------

  it("incrementQueued / decrementQueued track per-provider queue depth", () => {
    const m = new ProviderStateMap();
    m.register("ollama");
    assert.equal(m.get("ollama")!.queued, 0);

    m.incrementQueued("ollama");
    assert.equal(m.get("ollama")!.queued, 1);

    m.incrementQueued("ollama");
    assert.equal(m.get("ollama")!.queued, 2);

    m.decrementQueued("ollama");
    assert.equal(m.get("ollama")!.queued, 1);

    m.decrementQueued("ollama");
    assert.equal(m.get("ollama")!.queued, 0);
  });

  it("decrementQueued never drives queued below 0", () => {
    const m = new ProviderStateMap();
    m.register("safe");
    m.decrementQueued("safe");
    assert.equal(m.get("safe")!.queued, 0);

    m.decrementQueued("safe");
    assert.equal(m.get("safe")!.queued, 0);
  });

  it("incrementQueued / decrementQueued are no-ops for unregistered providers", () => {
    const m = new ProviderStateMap();
    m.incrementQueued("ghost"); // should not throw
    m.decrementQueued("ghost"); // should not throw
  });

  // -- snapshot ---------------------------------------------------------------

  it("snapshot returns correct shape for an idle provider", () => {
    const m = new ProviderStateMap();
    m.register("idle", { maxConcurrent: 3, rpmLimit: 20 });
    const s = m.snapshot();
    assert.ok(s.idle);
    assert.equal(s.idle.active, 0);
    assert.equal(s.idle.queued, 0);
    assert.equal(s.idle.maxConcurrent, 3);
    assert.equal(s.idle.coolingUntil, null);
    assert.equal(s.idle.breakerUntil, null);
    assert.equal(s.idle.rpmLimit, 20);
    assert.ok(s.idle.rpmTokens !== null && s.idle.rpmTokens > 19);
    assert.equal(s.idle.cooldownFallbackMs, null);
  });

  it("snapshot includes active and queued state", () => {
    const m = new ProviderStateMap();
    m.register("busy", { maxConcurrent: 2 });
    m.acquire("busy");
    m.incrementQueued("busy");
    m.incrementQueued("busy");

    const s = m.snapshot();
    assert.equal(s.busy.active, 1);
    assert.equal(s.busy.queued, 2);
  });

  it("snapshot is empty when no providers are registered", () => {
    const m = new ProviderStateMap();
    assert.deepEqual(m.snapshot(), {});
  });
});
