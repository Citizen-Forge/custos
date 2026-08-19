// Pins isAssignCheckStale: the fallback that forces tickProject to
// reconsider assignReady at least once an hour even when the ready-column
// fingerprint hasn't changed. See ProjectSettings.lastAssignCheckedAt's
// doc comment for the live symptom this exists to fix -- a ready ticket
// blocked on something external (a PR merge) leaves the fingerprint at a
// permanent fixed point once inFlight settles at 0, so nothing short of a
// time-based recheck ever looks at it again.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAssignCheckStale, ASSIGN_STALE_RECHECK_MS, isGroomCheckStale, GROOM_STALE_RECHECK_MS } from "./shared.js";

describe("isAssignCheckStale", () => {
  it("is stale when lastAssignCheckedAt is null (never checked)", () => {
    assert.equal(isAssignCheckStale(null, Date.now()), true);
  });

  it("is not stale immediately after a check", () => {
    const now = Date.now();
    assert.equal(isAssignCheckStale(now, now), false);
  });

  it("is not stale just under the recheck window", () => {
    const now = Date.now();
    assert.equal(isAssignCheckStale(now - (ASSIGN_STALE_RECHECK_MS - 1), now), false);
  });

  it("is stale exactly at the recheck window", () => {
    const now = Date.now();
    assert.equal(isAssignCheckStale(now - ASSIGN_STALE_RECHECK_MS, now), true);
  });

  it("is stale well past the recheck window", () => {
    const now = Date.now();
    assert.equal(isAssignCheckStale(now - ASSIGN_STALE_RECHECK_MS * 10, now), true);
  });
});

// Pins isGroomCheckStale: the same fallback as isAssignCheckStale above,
// for groomBacklog. See ProjectSettings.lastGroomCheckedAt's doc comment
// for the live symptom this exists to fix -- a backlog ticket blocked on
// something external (a dependency PR merging) leaves lastGroomSignal at
// a permanent fixed point once the backlog itself stops changing, so
// nothing short of a time-based recheck ever looks at it again. Confirmed
// live: 19 backlog tickets sat un-promoted for 10 days after the PR their
// own groom comments cited as blocking had already merged.
describe("isGroomCheckStale", () => {
  it("is stale when lastGroomCheckedAt is null (never checked)", () => {
    assert.equal(isGroomCheckStale(null, Date.now()), true);
  });

  it("is not stale immediately after a check", () => {
    const now = Date.now();
    assert.equal(isGroomCheckStale(now, now), false);
  });

  it("is not stale just under the recheck window", () => {
    const now = Date.now();
    assert.equal(isGroomCheckStale(now - (GROOM_STALE_RECHECK_MS - 1), now), false);
  });

  it("is stale exactly at the recheck window", () => {
    const now = Date.now();
    assert.equal(isGroomCheckStale(now - GROOM_STALE_RECHECK_MS, now), true);
  });

  it("is stale well past the recheck window", () => {
    const now = Date.now();
    assert.equal(isGroomCheckStale(now - GROOM_STALE_RECHECK_MS * 10, now), true);
  });
});
