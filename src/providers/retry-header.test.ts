// Pure-function contract for the shared Retry-After parser. No fetch
// mocking needed: the parser takes a Headers object and returns a
// number | undefined. Pins:
//   - numeric seconds → ms (the canonical Gemini / Anthropic answer)
//   - HTTP-date → ms-until-then (the RFC 7231 alternative)
//   - past-date clamp to 0 (clock-skew safety)
//   - missing / unparseable → undefined (router default-cooldown path)
//
// These tests gate the symptom: Gemini Free quota-exhausted responses
// carry a Retry-After value, and without this parser reaching the
// router's CooldownTracker, the gateway would silently downgrade it
// to 60s and re-attempt during quota cooldown, getting 429'd again,
// repeating indefinitely without ever producing a completion.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs } from "./retry-header.js";

describe("parseRetryAfterMs", () => {
  it("returns numeric seconds * 1000 for plain-integer Retry-After", () => {
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "30" })), 30_000);
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "120" })), 120_000);
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "1" })), 1_000);
  });

  it("handles zero seconds as zero (immediate retry-allowed)", () => {
    // Some load balancers return 0 to signal "no wait". Clamped to 0,
    // not negative — the gateway should treat this as "retry now"
    // and let the rate-limit throttle queue if necessary, not as
    // a past-deadline.
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "0" })), 0);
  });

  it("parses HTTP-date format into ms-until-instant", () => {
    // The test runner's clock between `new Date(Date.now() + ...)`
    // and `Date.parse(header) - Date.now()` inside the parser can
    // drift by hundreds of ms under CI load (observed ~600ms in
    // the worst case). ±1s slack is enough headroom without
    // weakening the assertion: a regression that returned seconds
    // instead of ms (0.06 instead of 60_000) would still fail the
    // lower bound, and a regression that returned the raw epoch
    // (~1.7e12) would fail the upper bound trivially.
    const futureMs = 60_000;
    const future = new Date(Date.now() + futureMs).toUTCString();
    const parsed = parseRetryAfterMs(new Headers({ "retry-after": future }));
    assert.ok(parsed !== undefined, "must return a number for HTTP-date");
    assert.ok(parsed! > futureMs - 1_000 && parsed! <= futureMs,
      `expected ~${futureMs}ms for a 60-second-future date, got ${parsed}`);
  });

  it("clamps past-date Retry-After to 0, never negative", () => {
    // Tomorrow the system reminder said "current date July 28, 2026";
    // for the test we synthesize a past date in the test runner's clock.
    const past = new Date(Date.now() - 60_000).toUTCString();
    const parsed = parseRetryAfterMs(new Headers({ "retry-after": past }));
    assert.equal(parsed, 0, "past-date must clamp to 0, not negative");
  });

  it("returns undefined when Retry-After header is missing", () => {
    assert.equal(parseRetryAfterMs(new Headers({})), undefined);
  });

  it("returns undefined when Retry-After is unparseable", () => {
    // Random non-numeric, non-date string -> undefined, NOT a NaN
    // or a fallback value. The router's CooldownTracker relies on
    // undefined to mean "use DEFAULT_COOLDOWN_MS = 60_000".
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "soon-ish" })), undefined);
  });

  it("Retry-After: 'NaN' or numeric-looking garbage returns undefined", () => {
    // Number('NaN') is NaN (not finite); falls through to HTTP-date
    // parsing; Date.parse('NaN') is NaN; falls through to undefined.
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "NaN" })), undefined);
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "Infinity" })), undefined);
  });
});
