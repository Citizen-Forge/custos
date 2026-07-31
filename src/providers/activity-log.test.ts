// ActivityLog.mostRecentEventForAgent contract.
//
// Regression coverage for surfacing sub-agent activity onto a top-level
// run's status: a Task sub-agent spawned by the `claude` CLI reuses the
// parent's ANTHROPIC_MODEL alias, so its own dispatches land in the
// activity log under the same agentId as the parent run -- even though
// the parent process's own stdout stream emits nothing while it waits on
// that sub-agent. mostRecentEventForAgent is how the orchestrator
// distinguishes "genuinely stalled" from "a sub-agent is doing real work
// I can't otherwise see."
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog } from "./activity-log.js";

describe("ActivityLog.mostRecentEventForAgent", () => {
  it("returns null when no event carries the given agentId", () => {
    const log = new ActivityLog();
    log.record({ requestId: "r1", timestamp: 1, outcome: "dispatched", agentId: "other-agent" });
    assert.equal(log.mostRecentEventForAgent("agent-1"), null);
  });

  it("returns the most recent event among several matching the agentId", () => {
    // Realistic ordering: the log only ever appends in the order events
    // actually happen, so insertion order and timestamp order agree --
    // unlike a synthetic out-of-order timestamp sequence, which the
    // insertion-order scan (correctly) wouldn't reorder to match.
    const log = new ActivityLog();
    log.record({ requestId: "r1", timestamp: 100, outcome: "dispatched", agentId: "agent-1" });
    log.record({ requestId: "r2", timestamp: 150, outcome: "dispatched", agentId: "other-agent" });
    log.record({ requestId: "r3", timestamp: 200, outcome: "fallback", agentId: "agent-1" });
    log.record({ requestId: "r4", timestamp: 300, outcome: "succeeded", agentId: "agent-1" });

    const latest = log.mostRecentEventForAgent("agent-1");
    assert.ok(latest);
    assert.equal(latest.timestamp, 300);
    assert.equal(latest.requestId, "r4");
    assert.equal(latest.outcome, "succeeded");
  });

  it("finds a match even when it isn't the newest event overall", () => {
    const log = new ActivityLog();
    log.record({ requestId: "r1", timestamp: 100, outcome: "dispatched", agentId: "agent-1" });
    log.record({ requestId: "r2", timestamp: 500, outcome: "dispatched", agentId: "other-agent" });

    const latest = log.mostRecentEventForAgent("agent-1");
    assert.ok(latest);
    assert.equal(latest.requestId, "r1");
  });
});
