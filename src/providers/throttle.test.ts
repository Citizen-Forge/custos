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
});
