// Throttle contracts for ThrottledProvider.
//
// Pin the per-provider concurrency limiter's behavior so the runtime
// wiring in runtime.ts can rely on it:
//   - a saturated provider queues FIFO, doesn't drop
//   - slot release happens on success AND on failure (no deadlock
//     on rejected inner calls)
//   - aborting a queued entry removes it from the queue without
//     consuming a slot
//   - each ThrottledProvider instance has its own queue, so a busy
//     Ollama doesn't hold up a free Anthropic
//   - maxConcurrent=N allows exactly N concurrent and never more
//
// Each test uses a fake Provider whose complete() resolves on a
// controlled timer; no network, no module mocking.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ThrottledProvider } from "./throttle.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { AnthropicMessagesRequest } from "../types.js";

const ZERO_REQ = {} as AnthropicMessagesRequest;
const OK_RESPONSE: ProviderResponse = { status: 200, headers: new Headers(), body: null };

function makeBlockingProvider(): Provider {
  // A provider whose complete() never settles naturally; honors an
  // abort signal so callers don't leak orphan promises once they abort
  // (the per-test `.catch(() => {})` cleanup becomes a no-op rather
  // than a hang). Used for asserting in-flight / queued counts at a
  // steady state without racing the timer.
  return {
    name: "blocking",
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

function makeSequencedProvider(
  resolutions: Array<{ delayMs: number; throw?: Error }>,
): { provider: Provider; callOrder: number[]; startOrder: number[] } {
  let idx = 0;
  const startOrder: number[] = [];
  const callOrder: number[] = [];
  const provider: Provider = {
    name: "sequenced",
    complete: () => {
      const myId = idx++;
      startOrder.push(myId);
      const spec = resolutions[myId] ?? { delayMs: 0 };
      return new Promise<ProviderResponse>((resolve, reject) => {
        setTimeout(() => {
          callOrder.push(myId);
          if (spec.throw) reject(spec.throw);
          else resolve(OK_RESPONSE);
        }, spec.delayMs);
      });
    },
  };
  return { provider, callOrder, startOrder };
}

// Same shape as makeSequencedProvider but the caller passes priority-bearing
// options into each `complete()` invocation, and the returned `invocations`
// array records the priority seen at each invocation. The ID counter still
// goes up at invocation time (not at submission time), so the SLOTS in
// `invocations` correspond to invocation order -- not submission order. The
// priority tag at each slot is what the priority tests assert on, since
// that's what distinguishes interactive vs background routing.
function makeSequencedPriorityProvider(
  resolutions: Array<{ delayMs: number }>,
): { provider: Provider; invocations: string[] } {
  let idx = 0;
  const invocations: string[] = [];
  const provider: Provider = {
    name: "sequenced-priority",
    complete: (_req, options) => {
      invocations.push(options?.priority ?? "default");
      const myId = idx++;
      const spec = resolutions[myId] ?? { delayMs: 0 };
      return new Promise<ProviderResponse>((resolve) => {
        setTimeout(() => resolve(OK_RESPONSE), spec.delayMs);
      });
    },
  };
  return { provider, invocations };
}

describe("ThrottledProvider", () => {
  it("queues submissions so only maxConcurrent run at a time", async () => {
    const inner = makeBlockingProvider();
    const t = new ThrottledProvider(inner, { maxConcurrent: 2 });
    const p1 = t.complete(ZERO_REQ);
    const p2 = t.complete(ZERO_REQ);
    assert.equal(t.active, 2, "first two should be in-flight");
    assert.equal(t.queued, 0, "no queue yet at the limit");

    const p3 = t.complete(ZERO_REQ);
    const p4 = t.complete(ZERO_REQ);
    assert.equal(t.active, 2, "still capped at 2 in-flight");
    assert.equal(t.queued, 2, "the extras should be queued");

    // Dangling promises -- abort so the test process doesn't hang.
    p1.catch(() => {});
    p2.catch(() => {});
    p3.catch(() => {});
    p4.catch(() => {});
    // Don't await -- they're intentionally unresolved so the slot
    // accounting above is stable. Cancel by aborting to avoid
    // keeping the fake's promise alive past the test.
  });

  it("releases the slot when an in-flight call rejects", async () => {
    const inner: Provider = {
      name: "always-fails",
      complete: async () => {
        throw new Error("boom");
      },
    };
    const t = new ThrottledProvider(inner, { maxConcurrent: 1 });
    await assert.rejects(() => t.complete(ZERO_REQ), /boom/);
    assert.equal(t.active, 0, "slot must release on rejection so the throttle doesn't deadlock");
    assert.equal(t.queued, 0);
  });

  it("releases the slot when an in-flight call resolves", async () => {
    const t = new ThrottledProvider(
      { name: "ok", complete: async () => OK_RESPONSE },
      { maxConcurrent: 1 },
    );
    await t.complete(ZERO_REQ);
    assert.equal(t.active, 0);
    assert.equal(t.queued, 0);
  });

  it("FIFO ordering: queued submissions resolve in submission order", async () => {
    // All entries take the same delay; with one slot, the order in
    // which they finish == the order in which they were submitted.
    const { provider } = makeSequencedProvider([
      { delayMs: 30 },
      { delayMs: 30 },
      { delayMs: 30 },
      { delayMs: 30 },
    ]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1 });
    const order: number[] = [];
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      ps.push(
        t.complete(ZERO_REQ).then(() => {
          order.push(i);
        }),
      );
    }
    await Promise.all(ps);
    assert.deepEqual(order, [0, 1, 2, 3], "submissions resolved in submission order");
  });

  it("aborting a queued entry removes it from the queue without consuming a slot", async () => {
    const inner = makeBlockingProvider();
    const t = new ThrottledProvider(inner, { maxConcurrent: 1 });

    const c1 = new AbortController();
    const p1 = t.complete(ZERO_REQ, { signal: c1.signal });
    assert.equal(t.active, 1);
    assert.equal(t.queued, 0);

    const c2 = new AbortController();
    const p2 = t.complete(ZERO_REQ, { signal: c2.signal });
    assert.equal(t.queued, 1, "second submission should queue behind the active one");

    // Aborting a queued entry rejects its promise without taking a slot --
    // the abort listener splices the queue. After the abort the
    // remaining queue length must drop back to zero.
    c2.abort();
    await assert.rejects(p2, (err: unknown) => {
      assert.ok(err instanceof Error);
      // AbortError (DOMException) or whatever reason the caller passed;
      // either way name is AbortError or the caller-supplied reason.
      return true;
    });
    assert.equal(t.queued, 0, "aborted queued entry should not consume a slot");
    assert.equal(t.active, 1, "the original p1 is still in-flight, untouched");

    // Cleanup the orphan pending promise so the test doesn't leak.
    c1.abort();
    p1.catch(() => {});
  });

  it("keeps independent queues per ThrottledProvider instance", async () => {
    const a = makeBlockingProvider();
    const b = makeBlockingProvider();
    const ta = new ThrottledProvider(a, { maxConcurrent: 1 });
    const tb = new ThrottledProvider(b, { maxConcurrent: 1 });
    const pa = ta.complete(ZERO_REQ);
    const pb = tb.complete(ZERO_REQ);
    assert.equal(ta.active, 1, "a is busy in its own queue");
    assert.equal(tb.active, 1, "b is busy in its own queue -- independent of a");
    assert.equal(ta.queued, 0);
    assert.equal(tb.queued, 0);

    pa.catch(() => {});
    pb.catch(() => {});
  });

  it("maxConcurrent=N allows exactly N concurrent and queues the (N+1)th", async () => {
    // Use a sequenced provider so the test can assert the timing with
    // a single delay cadence: every inner call takes 30ms. With slots=3
    // and 7 callers, the first 3 start immediately, the rest queue.
    // Total wall time should be roughly ceil(7/3) * 30ms (minus jitter).
    // We sample-after-rather-than-timing because Wall-time assertions are
    // flaky in CI; the assert is "never exceeded slots=3".
    let maxActiveObserved = 0;
    let active = 0;
    const inner: Provider = {
      name: "counting",
      complete: async () => {
        active += 1;
        maxActiveObserved = Math.max(maxActiveObserved, active);
        await new Promise<void>((r) => setTimeout(r, 30));
        active -= 1;
        return OK_RESPONSE;
      },
    };
    const t = new ThrottledProvider(inner, { maxConcurrent: 3 });
    const ps = Array.from({ length: 7 }, () => t.complete(ZERO_REQ));
    await Promise.all(ps);
    assert.equal(maxActiveObserved, 3, "maxConcurrent cap was respected");
    assert.equal(t.active, 0);
    assert.equal(t.queued, 0);
  });

  it("after a slot releases, the next queued entry starts", async () => {
    const { provider } = makeSequencedProvider([{ delayMs: 10 }, { delayMs: 10 }]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1 });
    const ps = [t.complete(ZERO_REQ), t.complete(ZERO_REQ)];
    await Promise.all(ps);
    assert.equal(t.active, 0);
    assert.equal(t.queued, 0);
  });

  it("constructor rejects non-positive maxConcurrent", () => {
    assert.throws(
      () => new ThrottledProvider({ name: "x", complete: async () => OK_RESPONSE }, { maxConcurrent: 0 }),
      /positive integer/,
    );
    assert.throws(
      () => new ThrottledProvider({ name: "x", complete: async () => OK_RESPONSE }, { maxConcurrent: -1 }),
      /positive integer/,
    );
    assert.throws(
      () => new ThrottledProvider({ name: "x", complete: async () => OK_RESPONSE }, { maxConcurrent: 1.5 }),
      /positive integer/,
    );
  });

  it("preserves the wrapped provider's name on the throttle's name field", () => {
    const t = new ThrottledProvider({ name: "ollama", complete: async () => OK_RESPONSE }, { maxConcurrent: 1 });
    assert.equal(t.name, "ollama");
  });

  it("abortAll rejects queued entries and aborts in-flight inner calls", async () => {
    // Inner provider whose complete() honors the abort signal by
    // rejecting with an AbortError-like error. Records which calls
    // started so we can assert each in-flight call's signal fired.
    const startedAborts: boolean[] = [];
    const inner: Provider = {
      name: "abortable",
      complete: (_req, options) =>
        new Promise<ProviderResponse>((resolve, reject) => {
          const signal = options?.signal;
          if (signal) {
            if (signal.aborted) {
              startedAborts.push(true);
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                startedAborts.push(true);
                reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
              },
              { once: true },
            );
          }
          // Never resolve naturally in this test -- abortAll is what
          // closes us out.
          void resolve;
        }),
    };
    const t = new ThrottledProvider(inner, { maxConcurrent: 2 });

    // Saturate: 2 in flight, 3 queued.
    const ps = Array.from({ length: 5 }, () => t.complete(ZERO_REQ));
    assert.equal(t.active, 2);
    assert.equal(t.queued, 3);

    t.abortAll("runtime reload");

    // Every promise must reject. The exact message split: queued
    // entries use `abortAll`'s reason verbatim (they're still
    // PendingEntry items rejected directly from the pending list);
    // in-flight entries come from the inner provider's own abort
    // handling, which wraps the abort's default reason in
    // `new Error("aborted")`. Locking the message in the assertion
    // would tie this test to that implementation detail, so we only
    // assert "any Error" -- the contract under test is "every
    // submission rejects, and the throttle empties out."
    await Promise.all(
      ps.map((p) =>
        assert.rejects(p, (err: unknown) => {
          assert.ok(err instanceof Error, "rejection should be an Error");
          return true;
        }),
      ),
    );
    assert.equal(t.active, 0, "inner aborts released the in-flight slots");
    assert.equal(t.queued, 0, "queued entries spliced out");
    assert.equal(startedAborts.length, 2, "every in-flight inner saw its abort signal fire");
  });

  it("abortAll with a thrown reason propagates the same Error", async () => {
    // For queued entries: abortAll rejects them directly with the
    // given Error (or a wrapped string), so the rejection message
    // matches verbatim. For in-flight entries the inner provider
    // decides the message; here we only test the queued path so we
    // can lock the message.
    const t = new ThrottledProvider(makeBlockingProvider(), { maxConcurrent: 1 });
    const c = new Error("config-rolled-back");
    const p = t.complete(ZERO_REQ); // gets a slot directly (1 slot available)
    assert.equal(t.active, 1);
    assert.equal(t.queued, 0);

    // Queue a second submission that will sit in pending behind the
    // active one. Then abortAll with the Error so the queued entry's
    // rejection carries that exact message.
    const p2 = t.complete(ZERO_REQ);
    assert.equal(t.queued, 1);
    t.abortAll(c);

    await assert.rejects(p2, /config-rolled-back/);
    // The in-flight call's inner completes asynchronously through
    // its signal-aware path (makeBlockingProvider honors abort).
    p.catch(() => {});
  });

  // -- Priority queue ----------------------------------------------------

  it("priority queue: backgrounds drain FIFO within their bucket", async () => {
    // All three submissions are background. With one slot and no
    // interactive traffic, every invocation's priority tag is the
    // same. Bucket-level FIFO is pinned via deeper-tail assertions
    // elsewhere; here we lock the bucket assignment.
    const { provider, invocations } = makeSequencedPriorityProvider([
      { delayMs: 5 },
      { delayMs: 5 },
      { delayMs: 5 },
    ]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1 });
    const ps = Array.from({ length: 3 }, () => t.complete(ZERO_REQ, { priority: "background" }));
    await Promise.all(ps);
    assert.deepEqual(invocations, ["background", "background", "background"], "every invocation was a background");
  });

  it("priority queue: interactive preempts background when a slot frees", async () => {
    // Submit order: bg, bg, int. With one slot and the priority queue,
    // the order in which invocation priority tags appear should be:
    // bg (in-flight), interactive (jumps ahead of the queued bg),
    // bg (last). If the throttle were just FIFO we'd see
    // ["background", "background", "interactive"] instead.
    const { provider, invocations } = makeSequencedPriorityProvider([
      { delayMs: 20 },
      { delayMs: 20 },
      { delayMs: 20 },
    ]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1 });
    const bg1 = t.complete(ZERO_REQ, { priority: "background" });
    const bg2 = t.complete(ZERO_REQ, { priority: "background" });
    const int1 = t.complete(ZERO_REQ, { priority: "interactive" });

    assert.equal(t.active, 1, "bg1 takes the slot");
    assert.equal(t.queuedFor("background"), 1, "bg2 sits in the background bucket");
    assert.equal(t.queuedFor("interactive"), 1, "int1 sits in the interactive bucket");

    await Promise.all([bg1, bg2, int1]);
    assert.deepEqual(invocations, ["background", "interactive", "background"], "interactive jumped ahead of the queued background");
  });

  it("anti-starvation: aged background preempts fresh interactive", async () => {
    // bg1 takes slot with a long-enough delay (70ms) that bg2 ages
    // past agedMs (50ms) while bg1 is running. All three are submitted
    // in the same tick so both bg2 and int1 sit queued. When bg1's
    // slot frees, the aged-head check in pickNext() routes bg2 ahead
    // of the fresh interactive.
    const { provider, invocations } = makeSequencedPriorityProvider([
      { delayMs: 70 }, // bg1 (long enough that bg2 ages past agedMs)
      { delayMs: 5 },  // bg2 (after aging promotion)
      { delayMs: 5 },  // int1 (last)
    ]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1, priorityAgedMs: 50 });
    const bg1 = t.complete(ZERO_REQ, { priority: "background" });
    const bg2 = t.complete(ZERO_REQ, { priority: "background" });
    const int1 = t.complete(ZERO_REQ, { priority: "interactive" });

    await Promise.all([bg1, bg2, int1]);
    assert.deepEqual(
      invocations,
      ["background", "background", "interactive"],
      "bg2 (head-aged over the threshold) preempted the fresh interactive",
    );
  });

  it("anti-starvation disabled (priorityAgedMs: 0): interactive always wins", async () => {
    // Same shape as the prior test, but aging is OFF. Even though
    // bg2 sat queued for ~70ms, the strict-priority pump still picks
    // the fresh interactive first. bg2 only runs once int1 finishes.
    const { provider, invocations } = makeSequencedPriorityProvider([
      { delayMs: 70 },
      { delayMs: 5 },
      { delayMs: 5 },
    ]);
    const t = new ThrottledProvider(provider, { maxConcurrent: 1, priorityAgedMs: 0 });
    const bg1 = t.complete(ZERO_REQ, { priority: "background" });
    const bg2 = t.complete(ZERO_REQ, { priority: "background" });
    const int1 = t.complete(ZERO_REQ, { priority: "interactive" });

    await Promise.all([bg1, bg2, int1]);
    assert.deepEqual(invocations, ["background", "interactive", "background"], "interactive wins despite the aged bg");
  });

  it("default priority (no options.priority) lands in the interactive bucket", async () => {
    // Existing call sites that predate the priority option shouldn't
    // accidentally start spilling into the background bucket. The
    // default is "interactive" so the historical behaviour holds.
    const inner = makeBlockingProvider();
    const t = new ThrottledProvider(inner, { maxConcurrent: 1 });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = t.complete(ZERO_REQ, { signal: c1.signal });
    assert.equal(t.active, 1, "first call took the slot");
    const b = t.complete(ZERO_REQ, { signal: c2.signal });
    assert.equal(t.queuedFor("interactive"), 1, "no-priority default call queued as interactive");
    assert.equal(t.queuedFor("background"), 0, "default does NOT spill into background");
    c1.abort();
    c2.abort();
    await Promise.allSettled([a, b]);
  });

  it("aborting a queued interactive does not disturb queued background entries", async () => {
    // One in-flight + a queued interactive + a queued background. The
    // queued interactive is aborted -- the background entry should
    // stay put and the active slot count should remain unchanged.
    const inner = makeBlockingProvider();
    const t = new ThrottledProvider(inner, { maxConcurrent: 1 });
    const cInflight = new AbortController();
    const cInteractive = new AbortController();
    const cBackground = new AbortController();
    const inflight = t.complete(ZERO_REQ, { priority: "interactive", signal: cInflight.signal });
    const qInteractive = t.complete(ZERO_REQ, { priority: "interactive", signal: cInteractive.signal });
    const qBackground = t.complete(ZERO_REQ, { priority: "background", signal: cBackground.signal });

    assert.equal(t.active, 1);
    assert.equal(t.queuedFor("interactive"), 1);
    assert.equal(t.queuedFor("background"), 1);

    cInteractive.abort();
    await assert.rejects(qInteractive, (err: unknown) => err instanceof Error);
    assert.equal(t.queuedFor("interactive"), 0, "aborted interactive removed from interactive bucket");
    assert.equal(t.queuedFor("background"), 1, "queued background untouched by the interactive abort");
    assert.equal(t.active, 1, "no slot consumed by the aborted queued interactive");

    // Cleanup the orphan promises so the test doesn't leak.
    cInflight.abort();
    cBackground.abort();
    inflight.catch(() => {});
    qBackground.catch(() => {});
  });

  it("abortAll with mixed interactive + background entries empties both buckets", async () => {
    // The full-abortAll path was previously exercised only with all
    // submissions in the default-interactive bucket. Pin it now with
    // a mix: 2 in-flight + 3 interactives queued + 2 backgrounds
    // queued. abortAll must finish with all promises rejected, both
    // sub-queues empty, and every in-flight inner aborted.
    const inner = makeBlockingProvider();
    const t = new ThrottledProvider(inner, { maxConcurrent: 2 });
    const inflightSignals = Array.from({ length: 2 }, () => new AbortController());
    const qInteractiveSignals = Array.from({ length: 3 }, () => new AbortController());
    const qBackgroundSignals = Array.from({ length: 2 }, () => new AbortController());
    const ps = [
      ...inflightSignals.map((c) => t.complete(ZERO_REQ, { priority: "interactive", signal: c.signal })),
      ...qInteractiveSignals.map((c) => t.complete(ZERO_REQ, { priority: "interactive", signal: c.signal })),
      ...qBackgroundSignals.map((c) => t.complete(ZERO_REQ, { priority: "background", signal: c.signal })),
    ];
    assert.equal(t.active, 2, "two slots occupied");
    assert.equal(t.queuedFor("interactive"), 3, "three interactives queued");
    assert.equal(t.queuedFor("background"), 2, "two backgrounds queued");

    t.abortAll("runtime reload");

    await Promise.all(ps.map((p) => assert.rejects(p, (err: unknown) => err instanceof Error)));
    assert.equal(t.active, 0, "abortAll aborted in-flight inner fetches; slots released");
    assert.equal(t.queuedFor("interactive"), 0, "abortAll cleared interactive queue");
    assert.equal(t.queuedFor("background"), 0, "abortAll cleared background queue");
  });
});
