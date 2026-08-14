// Pins the fallback-alias context round-trip -- format, then parse back --
// added when workItemId joined the context so a dispatch-byte-trace log
// line or a 413 could be tied back to a specific ticket instead of guessed
// at from timing under concurrent multi-agent load.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFallbackAlias, parseModelAlias } from "./model-alias.js";

describe("fallback alias context round-trip", () => {
  it("round-trips workItemId alongside the existing context fields", () => {
    const alias = formatFallbackAlias("complex", {
      projectId: "proj1",
      projectName: "lightspeed",
      agentId: "agent1",
      agentName: "Generalist Engineer",
      role: "engineer",
      workItemId: "AXOZKgz7BcEd",
    });
    const parsed = parseModelAlias(alias);
    assert.equal(parsed?.type, "fallback");
    assert.equal(parsed?.type === "fallback" && parsed.fallbackSet, "complex");
    assert.equal(parsed?.context?.workItemId, "AXOZKgz7BcEd");
    assert.equal(parsed?.context?.projectId, "proj1");
  });

  it("omits workItemId cleanly for project-level stages that have no ticket", () => {
    const alias = formatFallbackAlias("complex", {
      projectId: "proj1",
      agentId: "agent1",
      role: "product-owner",
    });
    const parsed = parseModelAlias(alias);
    assert.equal(parsed?.context?.workItemId, undefined);
    assert.equal(parsed?.context?.projectId, "proj1");
  });

  it("ignores a non-string workItemId in the suffix rather than throwing", () => {
    const malformed = `custos:fallback/complex?${encodeURIComponent(JSON.stringify({ projectId: "proj1", workItemId: 12345 }))}`;
    const parsed = parseModelAlias(malformed);
    assert.equal(parsed?.context?.workItemId, undefined);
    assert.equal(parsed?.context?.projectId, "proj1");
  });
});
