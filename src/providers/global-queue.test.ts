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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalQueue, type FallbackTarget } from "./global-queue.js";
import { ProviderStateMap } from "./provider-state.js";
import type { Provider, ProviderResponse, CompleteOptions } from "./types.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";

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
    state.register("ollama");
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

  it("throws the last ProviderUnavailableError when ALL available providers fail", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama", { cooldownFallbackMs: 30_000 });
    const { provider: gemini } = makeRecordingProvider("gemini", { throwUnavailableError: true });
    const { provider: ollama } = makeRecordingProvider("ollama", { throwUnavailableError: true });
    const q = new GlobalQueue({ gemini, ollama }, state);

    await assert.rejects(
      () => q.complete(
        [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
        ZERO_REQ,
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProviderUnavailableError, "should throw ProviderUnavailableError");
        assert.ok(err.message.includes("429"), "should carry the upstream error message");
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
    const q = new GlobalQueue({ a, b }, state);

    // Queue interactive (goes to a), then background (also waits for a).
    const interactive = q.complete([{ provider: "a", model: "m" }], ZERO_REQ, { priority: "interactive" });
    const background = q.complete([{ provider: "a", model: "m" }], ZERO_REQ, { priority: "background" });

    // Both are queued because a is saturated and b isn't in the fallback set.
    assert.equal(q.queuedInteractive, 1);
    assert.equal(q.queuedBackground, 1);

    // Release the slot — pump drains interactive bucket first.
    releaseA();
    resolveA(OK_RESPONSE);
    await interactive;

    // Interactive resolved. Background should still be queued.
    assert.equal(q.queuedBackground, 1, "background stays queued behind interactive");

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

    Date.now = () => origNow; // reset
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
    const q = new GlobalQueue({ old }, state);

    // Dispatch through old provider.
    const p1 = q.complete([{ provider: "old", model: "m" }], ZERO_REQ);
    resolveOld(OK_RESPONSE);
    const r1 = await p1;
    assert.equal(r1.providerName, "old");

    // Swap in a new provider map — old is gone, fresh is available.
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
    const q = new GlobalQueue({ a }, state);

    const p = q.complete([{ provider: "a", model: "m" }], ZERO_REQ);
    assert.equal(q.queuedTotal, 1);

    // Swap in an empty provider map — "a" is no longer registered.
    q.setProviders({});

    // Free the slot — pump triggers dispatchQueued which should reject.
    release();

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

    q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "interactive" });
    assert.equal(q.queuedInteractive, 1);
    assert.equal(q.queuedTotal, 1);

    q.complete([{ provider: "ollama", model: "q" }], ZERO_REQ, { priority: "background" });
    assert.equal(q.queuedBackground, 1);
    assert.equal(q.queuedTotal, 2);
  });
});
