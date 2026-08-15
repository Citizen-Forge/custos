// Pure-function contract for the shared retry-guidance parsers. No fetch
// mocking needed: parseRetryAfterMs takes a Headers object,
// parseGoogleRetryDelayMs takes a response body string, and
// parseUpstreamRetryDelayMs combines both -- each returns
// number | undefined. Pins:
//   - numeric seconds → ms (the canonical Anthropic/RFC 7231 answer)
//   - HTTP-date → ms-until-then (the RFC 7231 alternative)
//   - past-date clamp to 0 (clock-skew safety)
//   - missing / unparseable → undefined (router default-cooldown path)
//   - Google Cloud APIs' body-embedded RetryInfo (Gemini's actual
//     convention -- corrected below; an earlier version of this file
//     assumed Gemini sent Retry-After as a header, which turned out to
//     be wrong)
//
// These tests gate the real symptom, confirmed live: Gemini free-tier
// quota-exhaustion 429s carry NO Retry-After header at all -- only a
// `google.rpc.RetryInfo.retryDelay` entry in the response body. Before
// parseGoogleRetryDelayMs existed, parseRetryAfterMs(res.headers) always
// returned undefined for these, silently downgrading to whatever
// shorter default/fallback cooldown applied and re-attempting the
// still-exhausted quota every few seconds, forever, instead of waiting
// the ~20s Google actually asked for.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs, parseGoogleRetryDelayMs, parseUpstreamRetryDelayMs } from "./retry-header.js";

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

// Real quota-exhaustion body captured live from Gemini's free tier: a
// 429 with NO Retry-After header at all, only this body. This is the
// exact shape that made the gateway hammer an exhausted quota every ~6s
// (the local rpmLimit spacing, the only gate left once the header-only
// parser returned undefined) instead of waiting the ~20s Google asked
// for -- see parseGoogleRetryDelayMs's doc comment.
const REAL_GEMINI_QUOTA_BODY = JSON.stringify([
  {
    error: {
      code: 429,
      message: "You exceeded your current quota... Please retry in 19.940059881s.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaMetric: "generate_content_free_tier_input_token_count" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "19.940059881s" },
      ],
    },
  },
]);

describe("parseGoogleRetryDelayMs", () => {
  it("extracts retryDelay from a real captured Gemini quota-exhaustion body", () => {
    const ms = parseGoogleRetryDelayMs(REAL_GEMINI_QUOTA_BODY);
    assert.ok(ms !== undefined);
    assert.ok(Math.abs(ms! - 19_940) < 1, `expected ~19940ms, got ${ms}`);
  });

  it("handles a bare (non-array-wrapped) error object, plain integer seconds", () => {
    const body = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] } });
    assert.equal(parseGoogleRetryDelayMs(body), 30_000);
  });

  it("returns undefined when there's no RetryInfo entry among details", () => {
    const body = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure" }] } });
    assert.equal(parseGoogleRetryDelayMs(body), undefined);
  });

  it("returns undefined for non-JSON or JSON without an error.details array", () => {
    assert.equal(parseGoogleRetryDelayMs("not json"), undefined);
    assert.equal(parseGoogleRetryDelayMs(JSON.stringify({ error: { message: "plain error, no details" } })), undefined);
    assert.equal(parseGoogleRetryDelayMs(JSON.stringify({})), undefined);
  });

  it("returns undefined for a retryDelay that isn't a decimal-seconds duration string", () => {
    const body = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "soon" }] } });
    assert.equal(parseGoogleRetryDelayMs(body), undefined);
  });
});

describe("parseUpstreamRetryDelayMs", () => {
  it("prefers the Retry-After header when both header and Google body are present", () => {
    const ms = parseUpstreamRetryDelayMs(new Headers({ "retry-after": "5" }), REAL_GEMINI_QUOTA_BODY);
    assert.equal(ms, 5_000);
  });

  it("falls back to the Google body's RetryInfo when there is no Retry-After header -- the real Gemini case", () => {
    const ms = parseUpstreamRetryDelayMs(new Headers({}), REAL_GEMINI_QUOTA_BODY);
    assert.ok(ms !== undefined && Math.abs(ms - 19_940) < 1);
  });

  it("returns undefined when neither channel has anything usable", () => {
    assert.equal(parseUpstreamRetryDelayMs(new Headers({}), "not json"), undefined);
  });
});
