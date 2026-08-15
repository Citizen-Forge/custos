// GlobalQueue contracts.
//
// The global provider-aware queue manages ALL providers centrally with
// fallback-set resolution. These tests pin:
//   - tryExecute picks the first available provider in the fallback set
//   - failover to the next entry on ProviderUnavailableError
//   - queue when no provider is available right now
//   - pump drains queued requests when a slot frees up
//   - abortAll rejects all queued entries
//   - signal-aware abort of a queued entry removes it from the queue
//   - queued entry's provider not found → rejection with clear message
//   - non-availability errors from inner provider propagate immediately
//   - priority: interactive before background
//   - anti-starvation aging: aged background jumps ahead of fresh interactive
//   - modelOverride is threaded through to the provider's options
//
// Each test uses a fake Provider whose complete() resolves or rejects
// on a controlled schedule; no network, no module mocking.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { GlobalQueue, type FallbackTarget, type DeadLetterEntry } from "./global-queue.js";
import { ProviderStateMap } from "./provider-state.js";
import type { Provider, ProviderResponse, CompleteOptions } from "./types.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";

// The real Date.now function, preserved so the two tests below that fake
// the clock can restore it properly. `Date.now = () => origNow` (what
// those tests used to do to "reset") isn't a reset -- it re-freezes the
// clock to a fixed snapshot instead of restoring the live function,
// leaving Date.now() permanently stuck for every test that runs
// afterward in the same process. Confirmed live: that exact bug made a
// completely unrelated later test ("enqueue timeout fires after the
// configured deadline") compute `Date.now() - queuedAt === 0` no matter
// how much real time had actually passed, because both sides of the
// subtraction were reading the same frozen value. This file-level after()
// is a safety net on top of each test's own restore, in case an
// assertion throws between freezing the clock and un-freezing it.
const REAL_DATE_NOW = Date.now;
after(() => {
  Date.now = REAL_DATE_NOW;
});

const ZERO_REQ = {} as AnthropicMessagesRequest;
const OK_RESPONSE: ProviderResponse = { status: 200, headers: new Headers(), body: null };

/** A provider factory that records every invocation's options so tests can
 * assert modelOverride and priority were threaded through correctly.
 * Returns resolvePromise/rejectPromise so tests can control timing. */
function makeRecordingProvider(
  name: string,
  controlled: {
    /** Whether the inner complete throws ProviderUnavailableError. When set,
     * the inner rejects with that immediately regardless of the promise. */
    throwUnavailableError?: boolean;
    /** Whether the inner throws a generic Error. */
    throwGenericError?: boolean;
  } = {},
): {
  provider: Provider;
  seenOptions: CompleteOptions[];
  resolvePromise: (v: ProviderResponse) => void;
  rejectPromise: (e: Error) => void;
} {
  const seenOptions: CompleteOptions[] = [];
  let outerResolve: (value: ProviderResponse) => void = () => {};
  let outerReject: (err: Error) => void = () => {};
  const p = new Promise<ProviderResponse>((res, rej) => {
    outerResolve = res;
    outerReject = rej;
  });

  if (controlled.throwUnavailableError) {
    outerReject(new ProviderUnavailableError("upstream: HTTP 429", 60_000));
    p.catch(() => {}); // swallow the dangling rejection — complete() returns its own rejected promise
  }
  if (controlled.throwGenericError) {
    outerReject(new Error("malformed response"));
    p.catch(() => {});
  }

  const provider: Provider = {
    name,
    complete: (_req, options) => {
      seenOptions.push(options ?? {});
      if (controlled.throwUnavailableError) {
        return Promise.reject(new ProviderUnavailableError("upstream: HTTP 429", 60_000));
      }
      if (controlled.throwGenericError) {
        return Promise.reject(new Error("malformed response"));
      }
      return p;
    },
  };

  return {
    provider,
    seenOptions,
    // Expose promise controls so tests can resolve/reject on demand.
    resolvePromise: (v: ProviderResponse) => outerResolve(v),
    rejectPromise: (e: Error) => outerReject(e),
  };
}

/** A blocking provider whose complete() never settles naturally — used for
 * asserting queued / active counts without racing the timer. Honors abort
 * signal so callers don't leak orphan promises. */
function makeBlockingProvider(name: string): Provider {
  return {
    name,
    complete: (_req, options) =>
      new Promise<ProviderResponse>((resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
        void resolve;
      }),
  };
}

describe("GlobalQueue", () => {
  // -- pick first available ---------------------------------------------------

  it("picks the first available provider in the fallback set", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    state.register("gemini");
    const { provider: ollama, seenOptions: ollamaOpts, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const { provider: gemini } = makeRecordingProvider("gemini");
    const q = new GlobalQueue({ ollama, gemini }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }, { provider: "gemini", model: "gemini-2.5-flash" }],
      ZERO_REQ,
    );

    // ollama should be picked first — resolve its response.
    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama", "first available provider was chosen");
    assert.equal(ollamaOpts[0]?.modelOverride, "qwen2.5:14b", "modelOverride threaded through");
  });

  it("skips an unavailable provider and picks the next", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    state.register("gemini");
    // Make ollama unavailable (at concurrency cap)
    const release = state.acquire("ollama");
    assert.equal(state.canAccept("ollama"), false);

    const { provider: gemini, seenOptions: geminiOpts, resolvePromise: resolveGemini } = makeRecordingProvider("gemini");
    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama, gemini }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }, { provider: "gemini", model: "gemini-2.5-flash" }],
      ZERO_REQ,
    );

    resolveGemini(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "gemini", "fallback provider was chosen when primary is unavailable");
    assert.equal(geminiOpts[0]?.modelOverride, "gemini-2.5-flash", "modelOverride from the gemini entry threaded through");

    release();
  });

  it("skips a provider not in the providers map", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    state.register("gemini");
    const { provider: gemini, resolvePromise: resolveGemini } = makeRecordingProvider("gemini");
    // Only register gemini in the queue — ollama is absent.
    const q = new GlobalQueue({ gemini }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }, { provider: "gemini", model: "gemini-2.5-flash" }],
      ZERO_REQ,
    );

    resolveGemini(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "gemini", "entry not in providers map was skipped");
  });

  // -- failover on ProviderUnavailableError -----------------------------------

  it("fails over to the next provider when the first throws ProviderUnavailableError", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama");
    const { provider: gemini } = makeRecordingProvider("gemini", { throwUnavailableError: true });
    const { provider: ollama, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const p = q.complete(
      [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama", "failed over to ollama after gemini 429");

    // Gemini should now be on cooldown.
    assert.equal(state.canAccept("gemini"), false, "gemini marked cooling after 429");
  });

  it("fails over WITHOUT cooling the provider when ProviderUnavailableError.skipCooldown is set", async () => {
    // Regression: a request-specific failure (e.g. Gemini rejecting a
    // tool-call history that came from a different provider earlier in
    // the same fallback-set conversation) says nothing about whether
    // Gemini can serve a *different* request right now. Cooling the
    // whole provider over it would incorrectly block unrelated healthy
    // traffic for the cooldown window. skipCooldown must still fail over
    // to the next entry, just without touching ProviderStateMap.
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama");
    const gemini: Provider = {
      name: "gemini",
      complete: () => Promise.reject(new ProviderUnavailableError("gemini: incompatible tool-call history", undefined, true)),
    };
    const { provider: ollama, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const p = q.complete(
      [{ provider: "gemini", model: "gemini-3.5-flash-lite" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama", "failed over to ollama after gemini's skipCooldown error");
    assert.equal(state.canAccept("gemini"), true, "gemini must NOT be marked cooling — the failure was request-specific");
  });

  it("queues (rather than fails fast) when ALL available providers fail, and surfaces a queue-timeout if none recover in time", async () => {
    // Regression: tryExecute used to throw the last upstream error
    // immediately once every fallback-set entry had been tried and
    // failed, bypassing the queue entirely. That meant a fallback set
    // where the primary was attempted-and-failed while the rest were
    // simultaneously saturated (not literally "never available") failed
    // the caller fast instead of giving the queue's pumpAll a chance to
    // dispatch once something freed up -- the "agent's turn 503s even
    // though a fallback was seconds from having a slot" behavior. Now it
    // always queues; a short enqueueTimeoutMs here stands in for "nothing
    // ever recovered" so the test doesn't wait out the real 60s cooldown.
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama", { cooldownFallbackMs: 30_000 });
    const { provider: gemini } = makeRecordingProvider("gemini", { throwUnavailableError: true });
    const { provider: ollama } = makeRecordingProvider("ollama", { throwUnavailableError: true });
    const q = new GlobalQueue({ gemini, ollama }, state, undefined, { enqueueTimeoutMs: 50 });

    await assert.rejects(
      () => q.complete(
        [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
        ZERO_REQ,
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProviderUnavailableError, "should reject with ProviderUnavailableError");
        assert.match((err as Error).message, /queue timeout/, "queued and timed out rather than failing fast");
        return true;
      },
    );

    // Both should now be on cooldown.
    assert.equal(state.canAccept("gemini"), false);
    assert.equal(state.canAccept("ollama"), false);
  });

  it("propagates non-availability errors immediately without trying fallbacks", async () => {
    const state = new ProviderStateMap();
    state.register("gemini");
    state.register("ollama");
    const { provider: gemini } = makeRecordingProvider("gemini", { throwGenericError: true });
    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    await assert.rejects(
      () => q.complete(
        [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
        ZERO_REQ,
      ),
      /malformed response/, // generic error — not ProviderUnavailableError
    );
  });

  // -- queue when none available ----------------------------------------------

  it("queues the request when no provider is available at all", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    // Saturate the only slot.
    const release = state.acquire("ollama");
    assert.equal(state.canAccept("ollama"), false);

    const { provider: ollama, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    // Should be queued.
    assert.equal(q.queuedTotal, 1, "request should be queued");
    assert.equal(q.queuedInteractive, 1, "default priority is interactive");

    // Free the slot and trigger pump manually — pump is only called
    // from within executeWithRelease, not from StateMap.release().
    release();
    q.pump();

    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama", "queued request resolved after slot freed");
    assert.equal(q.queuedTotal, 0, "queue drained");
  });

  it("queues when all providers in the fallback set are on cooldown", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 300_000 });
    state.register("ollama", { cooldownFallbackMs: 30_000 });
    state.markCooling("gemini", 300_000);
    state.markCooling("ollama", 30_000);

    const { provider: gemini } = makeRecordingProvider("gemini");
    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const p = q.complete(
      [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    assert.equal(q.queuedTotal, 1, "request queued when all providers cooling");

    // Cleanup.
    q.abortAll("test cleanup");
    await assert.rejects(p, (err: unknown) => err instanceof Error);
  });

  // -- modelOverride ----------------------------------------------------------

  it("threads modelOverride from the fallback entry through to the provider", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    const { provider: ollama, seenOptions: opts, resolvePromise: resolve } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    resolve(OK_RESPONSE);
    await p;
    assert.equal(opts[0]?.modelOverride, "qwen2.5:14b", "modelOverride threaded to inner provider");
  });

  it("modelOverride is passed on the failover path too", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama");
    const { provider: gemini } = makeRecordingProvider("gemini", { throwUnavailableError: true });
    const { provider: ollama, seenOptions: ollamaOpts, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const p = q.complete(
      [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    resolveOllama(OK_RESPONSE);
    await p;
    assert.equal(ollamaOpts[0]?.modelOverride, "qwen2.5:14b", "modelOverride on failover");
  });

  // -- abortAll ---------------------------------------------------------------

  it("abortAll rejects all queued entries with the given reason", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama"); // saturate

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const p1 = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    const p2 = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 2);

    q.abortAll("runtime reload");

    await assert.rejects(p1, /runtime reload/);
    await assert.rejects(p2, /runtime reload/);
    assert.equal(q.queuedTotal, 0, "abortAll cleared both queues");

    release();
  });

  it("abortAll with mixed interactive + background empties both buckets", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const interactive = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "interactive" });
    const background = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "background" });

    assert.equal(q.queuedInteractive, 1);
    assert.equal(q.queuedBackground, 1);

    q.abortAll("reload");

    await assert.rejects(interactive, /reload/);
    await assert.rejects(background, /reload/);
    assert.equal(q.queuedTotal, 0);

    release();
  });

  // -- signal abort of queued entry -------------------------------------------

  it("aborting a queued entry's signal removes it from the queue without dispatching", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const ctrl = new AbortController();
    const p = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { signal: ctrl.signal });
    assert.equal(q.queuedTotal, 1);

    ctrl.abort("user cancelled");
    await assert.rejects(p, /user cancelled/);
    assert.equal(q.queuedTotal, 0, "aborted queued entry removed from queue");

    release();
  });

  // -- pump drains correctly --------------------------------------------------

  it("pump drains interactive before background when both buckets are queued", async () => {
    // Use two providers: one busy (so the fallback goes to the other) and
    // one available. Queue interactive, then background. Release the busy
    // slot and verify interactive resolves first while background stays.
    const state = new ProviderStateMap();
    state.register("a", { maxConcurrent: 1 });
    state.register("b", { maxConcurrent: 1 });
    const releaseA = state.acquire("a"); // saturate a

    const callOrder: string[] = [];
    const { provider: a, resolvePromise: resolveA } = makeRecordingProvider("a");
    const { provider: b, resolvePromise: resolveB } = makeRecordingProvider("b");
    // Explicit short timeout: this test doesn't exercise the enqueue-timeout
    // value itself, so it shouldn't be at the mercy of the production
    // default (raised to 180s to outlast a Groq TPM cooldown -- see
    // DEFAULT_ENQUEUE_TIMEOUT_MS in global-queue.ts). Keeps a pre-existing,
    // unrelated flake fast to fail instead of tripling its CI hang time.
    const q = new GlobalQueue({ a, b }, state, undefined, { enqueueTimeoutMs: 5_000 });

    // Queue interactive (goes to a), then background (also waits for a).
    const interactive = q.complete([{ provider: "a", model: "m" }], ZERO_REQ, { priority: "interactive" });
    const background = q.complete([{ provider: "a", model: "m" }], ZERO_REQ, { priority: "background" });

    // Both are queued because a is saturated and b isn't in the fallback set.
    assert.equal(q.queuedInteractive, 1);
    assert.equal(q.queuedBackground, 1);

    // Release the slot — pump drains interactive bucket first. releaseA()
    // only touches ProviderStateMap (acquired directly by this test, not
    // through the queue's own dispatch flow), which by design doesn't pump
    // on its own -- see ProviderStateMap.release()'s doc comment. The
    // queue only learns a slot freed up when something tells it to look,
    // same as every other test here that manipulates state directly.
    releaseA();
    q.pump();

    // The pump claimed the slot for interactive (now dispatched, no longer
    // queued) while background waits its turn -- this is the actual
    // "drains interactive before background" behavior under test. It has
    // to be checked right here: interactive's own dispatch is still
    // in-flight (unresolved provider.complete()) and holds the slot, so
    // background can't have been dispatched yet either. Checking this
    // AFTER `await interactive` below is too late -- completing
    // interactive's request releases its slot and re-pumps in the same
    // tick, which lets background through immediately, so a check after
    // that await would pass even if priority ordering were broken.
    assert.equal(q.queuedInteractive, 0, "interactive was claimed by the pump");
    assert.equal(q.queuedBackground, 1, "background stays queued while interactive is still in flight");

    resolveA(OK_RESPONSE);
    await interactive;

    // Cleanup the remaining background.
    q.abortAll("cleanup");
    background.catch(() => {});
  });

  it("pump drains queued request when a cooldown expires", async () => {
    // Queue a request while both providers are on cooldown, then advance
    // the clock and call pump() manually to verify it drains.
    const origNow = Date.now();
    Date.now = () => origNow; // freeze clock

    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.markCooling("gemini", 60_000);
    state.register("ollama", { cooldownFallbackMs: 30_000 });
    state.markCooling("ollama", 30_000);

    const { provider: gemini } = makeRecordingProvider("gemini");
    const { provider: ollama, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const p = q.complete(
      [{ provider: "gemini", model: "g" }, { provider: "ollama", model: "o" }],
      ZERO_REQ,
    );
    assert.equal(q.queuedTotal, 1, "queued while both cooling");

    // Advance past ollama's 30s cooldown (but not gemini's 60s).
    Date.now = () => origNow + 35_000;

    // Manual pump should find ollama available.
    q.pump();

    // The dispatch happened synchronously within pump(). The inner
    // complete resolves immediately since our recording provider's
    // promise is still at origNow... hmm, let me resolve it.
    // Actually the pump dispatches via dispatchQueued which calls
    // executeWithRelease. The inner promise is still the same promise
    // from makeRecordingProvider. Its resolve function is resolveOllama.
    // So after pump, we need to resolve it.
    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama", "cooldown-expired provider was dispatched");
    assert.equal(q.queuedTotal, 0, "queue drained after pump");

    Date.now = REAL_DATE_NOW; // restore the real clock, not another frozen snapshot
  });

  it("releases a provider's slot immediately on failure during a queued redispatch, not after the whole re-queue chain settles (regression: active-count leak)", async () => {
    // Regression for a real leak observed live: with every provider down
    // at once for hours, `active` on providers with no concurrency cap
    // climbed into the hundreds and never recovered. Root cause was
    // executeWithRelease() only releasing its slot in the outer `finally`,
    // which doesn't run until the whole recursive re-queue-and-redispatch
    // chain it kicks off on ProviderUnavailableError settles -- so a
    // provider's slot stayed "active" for as long as the entire nested
    // wait took (up to the enqueue timeout, or another full cycle of this
    // same failure), even though the real attempt against it had long
    // since finished.
    const origNow = Date.now();
    Date.now = () => origNow;

    const state = new ProviderStateMap();
    state.register("flaky", { cooldownFallbackMs: 30_000 });
    const { provider: flaky } = makeRecordingProvider("flaky", { throwUnavailableError: true });
    const q = new GlobalQueue({ flaky }, state);

    // First attempt: tryExecute's own per-entry loop tries flaky, fails,
    // cools it (60_000ms — hardcoded retryAfterMs in throwUnavailableError),
    // and — as the only fallback target — falls through to enqueue().
    const p1 = q.complete([{ provider: "flaky", model: "m" }], ZERO_REQ);
    p1.catch(() => {}); // never settles in this test; only state is asserted
    // q.complete() returns before the inner rejection has actually been
    // caught (that's still a pending microtask) -- give it a few ticks
    // before asserting the post-attempt state.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(q.queuedTotal, 1, "queued after the first failed attempt");
    assert.equal(state.get("flaky")!.active, 0, "tryExecute's own loop already released this slot correctly");

    // Advance past the cooldown and pump manually — this dispatches the
    // queued entry via dispatchQueued -> executeWithRelease, acquiring a
    // NEW slot for this second attempt.
    Date.now = () => origNow + 61_000;
    q.pump();

    // executeWithRelease's fetch is the same always-rejecting provider, so
    // this second attempt fails too, hits the ProviderUnavailableError
    // branch, and recurses into tryExecute — which finds flaky freshly
    // re-cooled (from THIS failure) and falls through to enqueue() again,
    // a promise that won't settle until yet another cooldown clears. Give
    // the async chain up to that point a few microtask ticks to run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(
      state.get("flaky")!.active,
      0,
      "second attempt's slot must be released immediately, not held hostage by the still-pending re-queued promise",
    );

    Date.now = REAL_DATE_NOW; // restore the real clock, not another frozen snapshot
  });

  // -- non-2xx responses -----------------------------------------------

  it("records upstream error body in activity log for non-2xx responses", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    const errorProvider: Provider = {
      name: "ollama",
      complete: async () => ({
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        body: new Blob([JSON.stringify({ error: { message: "invalid API key", type: "authentication_error" } })]).stream(),
      }),
    };
    const q = new GlobalQueue({ ollama: errorProvider }, state);

    const result = await q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    assert.equal(result.status, 401, "non-2xx response forwarded to caller");
    assert.equal(result.providerName, "ollama", "providerName stamped on response");

    const recent = q.queueActivityLog().recent(20);
    const failedEvent = recent.find((e) => e.outcome === "failed");
    assert.ok(failedEvent, "expected a failed event in the activity log");
    assert.ok(failedEvent!.errorMessage, "failed event carries an errorMessage");
    assert.ok(
      failedEvent!.errorMessage!.startsWith("HTTP 401:"),
      `errorMessage should start with 'HTTP 401:', got: "${failedEvent!.errorMessage}"`,
    );
    assert.ok(
      failedEvent!.errorMessage!.includes("invalid API key"),
      `errorMessage should include the upstream error text, got: "${failedEvent!.errorMessage}"`,
    );
  });

  it("non-2xx without a response body falls back to the default error message", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    const providerWithoutBody: Provider = {
      name: "ollama",
      complete: async () => ({
        status: 400,
        headers: new Headers(),
        body: null,
      }),
    };
    const q = new GlobalQueue({ ollama: providerWithoutBody }, state);

    await q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);

    const recent = q.queueActivityLog().recent(10);
    const failedEvent = recent.find((e) => e.outcome === "failed");
    assert.ok(failedEvent, "expected a failed event");
    assert.equal(
      failedEvent!.errorMessage,
      "HTTP 400 from provider",
      `fallback message when body is null, got: "${failedEvent!.errorMessage}"`,
    );
  });

  // -- priority queuing -------------------------------------------------------

  it("priority is passed through to the provider on dispatched requests", async () => {
    const state = new ProviderStateMap();
    state.register("ollama");
    const { provider: ollama, seenOptions, resolvePromise: resolve } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const p = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "background" });
    resolve(OK_RESPONSE);
    await p;

    assert.equal(seenOptions[0]?.priority, "background", "priority threaded through");
  });

  // -- setProviders / setStateMap --------------------------------------------

  it("setProviders replaces the providers map mid-lifecycle", async () => {
    const state = new ProviderStateMap();
    state.register("old");
    const { provider: old, resolvePromise: resolveOld } = makeRecordingProvider("old");
    // Explicit short timeout -- see the identical comment on "pump drains
    // interactive before background" above.
    const q = new GlobalQueue({ old }, state, undefined, { enqueueTimeoutMs: 5_000 });

    // Dispatch through old provider.
    const p1 = q.complete([{ provider: "old", model: "m" }], ZERO_REQ);
    resolveOld(OK_RESPONSE);
    const r1 = await p1;
    assert.equal(r1.providerName, "old");

    // Swap in a new provider map — old is gone, fresh is available. state
    // needs "fresh" registered too: canAccept() on an unregistered name
    // always returns false, which would strand this request in the queue
    // forever regardless of setProviders.
    state.register("fresh");
    const { provider: fresh, resolvePromise: resolveFresh } = makeRecordingProvider("fresh");
    q.setProviders({ fresh });
    const p2 = q.complete([{ provider: "old", model: "m" }, { provider: "fresh", model: "n" }], ZERO_REQ);
    resolveFresh(OK_RESPONSE);
    const r2 = await p2;
    assert.equal(r2.providerName, "fresh", "fell through old (not in new map) to fresh");
  });

  it("setStateMap replaces the state reference", () => {
    const old = new ProviderStateMap();
    old.register("p", { maxConcurrent: 1 });
    const fresh = new ProviderStateMap();
    fresh.register("p", { maxConcurrent: 1 });

    const { provider } = makeRecordingProvider("p");
    const q = new GlobalQueue({ p: provider }, old);
    assert.ok(q.queuedTotal === 0); // smoke — just proves the ref swap doesn't crash

    q.setStateMap(fresh);
    // After swap, the queue uses fresh's canAccept.
    const release = fresh.acquire("p"); // saturate fresh (maxConcurrent=1 means active=1 == cap)
    // No slot available through fresh.
    const p = q.complete([{ provider: "p", model: "m" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1, "queued because fresh's state has no slot");
    p.catch(() => {});
    release();
    q.abortAll("cleanup");
  });

  it("dispatchQueued with a missing provider rejects with a clear message", async () => {
    // Set up: saturate provider "a" so a request queues, then swap the
    // providers map to remove "a" before the slot frees. When pump()
    // runs, dispatchQueued finds no provider and rejects.
    const state = new ProviderStateMap();
    state.register("a", { maxConcurrent: 1 });
    const release = state.acquire("a"); // saturate

    const { provider: a } = makeRecordingProvider("a");
    // Explicit short timeout -- see the identical comment on "pump drains
    // interactive before background" above.
    const q = new GlobalQueue({ a }, state, undefined, { enqueueTimeoutMs: 5_000 });

    const p = q.complete([{ provider: "a", model: "m" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1);

    // Swap in an empty provider map — "a" is no longer registered.
    q.setProviders({});

    // Free the slot and pump — release() alone doesn't (see the identical
    // comment on "pump drains interactive before background" above) --
    // dispatchQueued finds no provider for "a" anymore and rejects.
    release();
    q.pump();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('a'), `should mention provider "a", got: ${err.message}`);
      assert.ok(err.message.includes('not found'), `should say "not found", got: ${err.message}`);
      return true;
    });
    assert.equal(q.queuedTotal, 0, "rejected entry removed from queue");
  });

  // -- stats ------------------------------------------------------------------

  it("queued* getters reflect current queue depths", () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    state.acquire("ollama"); // saturate

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    assert.equal(q.queuedTotal, 0);

    const interactive = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "interactive" });
    assert.equal(q.queuedInteractive, 1);
    assert.equal(q.queuedTotal, 1);

    const background = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "background" });
    assert.equal(q.queuedBackground, 1);
    assert.equal(q.queuedTotal, 2);

    // Cleanup: both complete() calls above are still queued (ollama stays
    // saturated all test long) and were never awaited. Left alone they'd
    // sit on the enqueue-timeout timer (180s default) and reject with an
    // unhandled rejection well after this synchronous test already
    // returned. abortAll clears them immediately instead.
    q.abortAll("cleanup");
    interactive.catch(() => {});
    background.catch(() => {});
  });

  // -- enqueue timeout + dead-letter buffer ---------------------------------

  it("enqueue timeout fires after the configured deadline; drops to dead-letter; rejects with ProviderUnavailableError", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, {
      enqueueTimeoutMs: 50,
      enqueueRetryAfterMs: 5_000,
    });

    const p = q.complete([{ provider: "ollama", model: "qwen2.5:14b" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1, "request should be parked");

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError, "expect ProviderUnavailableError");
      assert.equal((err as ProviderUnavailableError).retryAfterMs, 5_000, "retryAfterMs threaded through");
      assert.ok(err.message.startsWith("queue timeout:"), `error message starts with 'queue timeout:'; got: ${err.message}`);
      return true;
    });

    assert.equal(q.queuedTotal, 0, "queue cleared by timeout");
    assert.equal(state.get("ollama")!.queuedInteractive, 0, "queued counter decremented on timeout");

    const dead = q.deadLettersSnapshot();
    assert.equal(dead.length, 1, "one entry in dead-letter buffer");
    assert.equal(dead[0].reason, "timeout");
    assert.ok(dead[0].waitMs >= 50, `waitMs >= 50, got: ${dead[0].waitMs}`);
    assert.equal(dead[0].fallbackTargets.length, 1);
    assert.equal(dead[0].fallbackTargets[0].provider, "ollama");
    assert.equal(dead[0].fallbackTargets[0].model, "qwen2.5:14b");

    const recent = q.queueActivityLog().recent(5);
    const stuckEvents = recent.filter((e) => e.outcome === "stuck-request");
    assert.equal(stuckEvents.length, 1, "exactly one stuck-request event");
    assert.ok(stuckEvents[0].errorMessage!.startsWith("queue timeout:"), "stuck-request errorMessage starts with 'queue timeout:'");
    assert.ok(stuckEvents[0].durationMs !== undefined && stuckEvents[0].durationMs! >= 50);

    release();
  });

  it("slot freed before the deadline → dispatches normally, no stuck-request event, timer cleared", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama, resolvePromise: resolveOllama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 600 });

    const p = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1);

    // Free the slot and pump before the deadline would fire.
    release();
    q.pump();
    resolveOllama(OK_RESPONSE);
    const result = await p;
    assert.equal(result.providerName, "ollama");

    // Wait long enough for any leaked timer to fire to verify none did.
    await new Promise<void>((r) => setTimeout(r, 700));

    const stuckEvents = q.queueActivityLog().recent(20).filter((e) => e.outcome === "stuck-request");
    assert.equal(stuckEvents.length, 0, "no stuck-request after successful dispatch");
    assert.equal(q.deadLettersSnapshot().length, 0, "dead-letter empty after successful dispatch");
    assert.equal(q.queuedTotal, 0);
  });

  it("manual abort via signal → no stuck-request event, timer cleared", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 200 });

    const ctrl = new AbortController();
    const p = q.complete(
      [{ provider: "ollama", model: "q" }],
      ZERO_REQ,
      { signal: ctrl.signal },
    );
    assert.equal(q.queuedTotal, 1);

    ctrl.abort("user cancelled");
    await assert.rejects(p, /user cancelled/);
    assert.equal(q.queuedTotal, 0, "queue cleared by signal abort");

    // Wait past the would-be timeout to confirm no stuck-request fires.
    await new Promise<void>((r) => setTimeout(r, 250));

    const stuckEvents = q.queueActivityLog().recent(20).filter((e) => e.outcome === "stuck-request");
    assert.equal(stuckEvents.length, 0, "no stuck-request after manual abort");
    assert.equal(q.deadLettersSnapshot().length, 0, "dead-letter empty after manual abort");

    release();
  });

  it("abortAll clears all pending timeouts so they can't fire after the abort", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 120 });

    const p1 = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    const p2 = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    const p3 = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 3);

    q.abortAll("runtime reload");
    await assert.rejects(p1, /runtime reload/);
    await assert.rejects(p2, /runtime reload/);
    await assert.rejects(p3, /runtime reload/);

    // Wait past the would-be timeout to confirm no timers leaked.
    await new Promise<void>((r) => setTimeout(r, 200));

    const stuckEvents = q.queueActivityLog().recent(30).filter((e) => e.outcome === "stuck-request");
    assert.equal(stuckEvents.length, 0, "abortAll cleared timers — no stuck-request fires");
    assert.equal(q.deadLettersSnapshot().length, 0, "abortAll leaves dead-letter empty");

    release();
  });

  it("dead-letter ring buffer caps at 50 entries; oldest is shifted off on overflow (FIFO)", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 50 });

    // Drive 51 distinct enqueues. Each receives its own requestId from
    // the queue's internal counter. The activity log records the
    // `queued` event synchronously inside enqueue(), so the requestIds
    // are in enqueue-order in the log. With Node's setTimeout queue
    // processing same-delay timers in scheduling order, the dead-letter
    // pushes happen in the same enqueue order; the FIFO shift-oldest
    // implementation drops the first-enqueued entry on the 51st push.
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 51; i++) {
      ps.push(
        q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ).catch(() => {}),
      );
    }
    await Promise.all(ps);
    // Generous grace period so all 51 timers fire even on a slow CI.
    await new Promise<void>((r) => setTimeout(r, 200));

    const dead = q.deadLettersSnapshot();
    assert.equal(dead.length, 50, "dead-letter buffer caps at 50 entries");

    // Pin the FIFO semantic: the queue's requestId counter is monotonic
    // within a single process, so the enqueue-ordered requestIds are
    // a sorted slice of those. The first-enqueued id MUST be missing
    // (it's the only one shifted off); the last-enqueued MUST be
    // present. This is what makes "the most recent overflow stays
    // visible" hold for the operator's mental model.
    // ActivityLog.recent() returns newest-first (see its own .reverse()),
    // so the chronological first-enqueued id is the LAST element here and
    // the last-enqueued id is the FIRST -- inverted from what the names
    // might suggest at a glance.
    const queuedInOrder = q.queueActivityLog()
      .recent(1000)
      .filter((e) => e.outcome === "queued")
      .map((e) => e.requestId);
    assert.equal(queuedInOrder.length, 51, "all 51 enqueues recorded a queued event");
    const firstEnqueuedId = queuedInOrder[queuedInOrder.length - 1];
    const lastEnqueuedId = queuedInOrder[0];

    const deadIds = new Set(dead.map((d) => d.requestId));
    assert.equal(deadIds.size, 50, "50 distinct request ids in the dead-letter buffer (no duplicates)");
    assert.ok(!deadIds.has(firstEnqueuedId), `earliest-enqueued id ${firstEnqueuedId} was shifted off (FIFO)`);
    assert.ok(deadIds.has(lastEnqueuedId), `latest-enqueued id ${lastEnqueuedId} is still in the buffer (FIFO)`);

    release();
  });

  it("deadLettersSnapshot returns a defensive copy — each call yields a fresh array, mutations don't bleed back", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 5 });

    const p = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    await p.catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 15));

    // Each call returns a new array (slice() semantics).
    const a = q.deadLettersSnapshot();
    const b = q.deadLettersSnapshot();
    assert.notEqual(a, b, "each deadLettersSnapshot() call returns a fresh array");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);

    // Defensive copy: cast past the readonly type to mutate exactly
    // like a misbehaving caller would; verify the underlying buffer
    // is unaffected.
    const mutable = a as DeadLetterEntry[];
    mutable.length = 0;
    mutable.push({
      requestId: "fake",
      timestamp: 0,
      queuedAt: 0,
      waitMs: 0,
      fallbackTargets: [],
      priority: "interactive",
      reason: "timeout",
    });
    assert.equal(q.deadLettersSnapshot().length, 1, "buffer state unaffected by snapshot mutation");

    release();
  });

  it("stuck-request event carries the project's DispatchContext from the call site", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, { enqueueTimeoutMs: 10 });

    const p = q.complete(
      [{ provider: "ollama", model: "q" }],
      ZERO_REQ,
      { priority: "background" },
      { projectId: "p-lightspeed", agentId: "a-pm", role: "project-manager", fallbackSet: "complex" },
    );
    await p.catch(() => {});

    const recent = q.queueActivityLog().recent(5);
    const stuckEvent = recent.find((e) => e.outcome === "stuck-request");
    assert.ok(stuckEvent, "expected a stuck-request event");
    assert.equal(stuckEvent?.projectId, "p-lightspeed", "projectId propagated from call context");
    assert.equal(stuckEvent?.agentId, "a-pm", "agentId propagated from call context");
    assert.equal(stuckEvent?.role, "project-manager", "role propagated");
    assert.equal(stuckEvent?.fallbackSet, "complex", "fallbackSet propagated");
    assert.equal(stuckEvent?.provider, undefined, "no provider stamps the queue never picked one");
    assert.equal(stuckEvent?.model, undefined, "no model stamps the queue never picked one");

    release();
  });

  it("retryAfterMs from options is honored on the rejected ProviderUnavailableError", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama");

    const { provider: ollama } = makeRecordingProvider("ollama");
    const q = new GlobalQueue({ ollama }, state, undefined, {
      enqueueTimeoutMs: 10,
      enqueueRetryAfterMs: 30_000,
    });

    const p = q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ);
    await assert.rejects(p, (err: unknown) => {
      assert.equal((err as ProviderUnavailableError).retryAfterMs, 30_000);
      return true;
    });

    release();
  });

  // -- periodic pump safety net ------------------------------------------------

  it("periodic pump dispatches a request stranded behind a purely time-based RPM gate, with no reactive trigger", async () => {
    const state = new ProviderStateMap();
    // rpmLimit high enough that spacing is a few ms, not real seconds --
    // keeps this test fast without needing to fake Date.now().
    state.register("gemini", { rpmLimit: 6_000 }); // 60_000ms / 6000 = 10ms spacing
    // Consume the current RPM slot directly (not through the queue) so
    // canAccept() is genuinely false at the moment complete() is called --
    // mirrors the live bug: something else (a pre-spawn probe, in
    // production) took the slot outside the queue's own bookkeeping.
    const preConsume = state.acquire("gemini");
    preConsume();

    const { provider: gemini, seenOptions, resolvePromise } = makeRecordingProvider("gemini");
    // Resolved up front -- JS promises are safe to settle before anything
    // awaits them, and whenever the periodic sweep eventually dispatches
    // and calls provider.complete(), it gets back this already-resolved
    // promise straight away.
    resolvePromise(OK_RESPONSE);
    // periodicPumpIntervalMs well under the 10ms RPM spacing window's
    // typical elapse-and-check cadence, and critically: nothing in this
    // test ever calls q.pump() or completes any other request, so the
    // ONLY thing that can dispatch this request is the periodic sweep.
    const q = new GlobalQueue({ gemini }, state, undefined, { periodicPumpIntervalMs: 5 });

    const p = q.complete([{ provider: "gemini", model: "gemini-2.5-flash" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1, "RPM gate closed at the moment of the call — request should queue, not dispatch immediately");

    const result = await p;
    assert.equal(result.status, 200, "periodic sweep should have found the RPM gate open and dispatched");
    assert.equal(seenOptions.length, 1, "provider.complete() was actually invoked");
    assert.equal(q.queuedTotal, 0);
  });
});
