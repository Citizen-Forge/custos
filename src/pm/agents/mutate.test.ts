// Pins assertFallbackSetAllowed: the invariant that "principal" (real,
// metered Anthropic usage reserved for the escalation stage -- see
// orchestrator/escalation.ts) can never be assigned to any role but
// "principal", enforced from both createAgent and updateAgent so no
// write path (admin PATCH, EM tools, PM reassignment) can bypass it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pmDir = mkdtempSync(join(tmpdir(), "mutate-pm-"));
process.env.GATEWAY_PM_DIR = pmDir;

after(() => {
  rmSync(pmDir, { recursive: true, force: true });
});

const { createAgent, updateAgent, assertFallbackSetAllowed } = await import("./mutate.js");

describe("assertFallbackSetAllowed", () => {
  it("allows the principal role to use the principal set", () => {
    assert.doesNotThrow(() => assertFallbackSetAllowed("principal", "principal"));
  });

  it("throws when a non-principal role is given the principal set", () => {
    assert.throws(() => assertFallbackSetAllowed("engineer", "principal"), /reserved for the "principal" role/);
    assert.throws(() => assertFallbackSetAllowed("qa", "principal"), /reserved for the "principal" role/);
  });

  it("allows any role to use an unreserved set", () => {
    assert.doesNotThrow(() => assertFallbackSetAllowed("engineer", "standard"));
    assert.doesNotThrow(() => assertFallbackSetAllowed("principal", "standard"));
  });

  it("is a no-op when no fallback set is given", () => {
    assert.doesNotThrow(() => assertFallbackSetAllowed("engineer", undefined));
  });
});

describe("createAgent / updateAgent enforce the guard", () => {
  it("createAgent rejects a non-principal role created with the principal set", async () => {
    await assert.rejects(
      createAgent({ projectId: "p1", role: "engineer", name: "Eng", fallbackSet: "principal" }),
      /reserved for the "principal" role/,
    );
  });

  it("createAgent allows a principal-role agent to use the principal set", async () => {
    const agent = await createAgent({ projectId: "p1", role: "principal", name: "Principal", fallbackSet: "principal" });
    assert.equal(agent.fallbackSet, "principal");
  });

  it("updateAgent rejects re-pointing an existing engineer's fallbackSet to principal", async () => {
    const agent = await createAgent({ projectId: "p1", role: "engineer", name: "Eng", fallbackSet: "standard" });
    await assert.rejects(updateAgent(agent.id, { fallbackSet: "principal" }), /reserved for the "principal" role/);
    // The rejected write must not have landed -- the agent's own record
    // is the source of truth, not just the thrown error.
    const { getAgent } = await import("./store.js");
    const fresh = await getAgent(agent.id);
    assert.equal(fresh!.fallbackSet, "standard");
  });

  it("updateAgent allows changing an unrelated field without touching fallbackSet", async () => {
    const agent = await createAgent({ projectId: "p1", role: "engineer", name: "Eng", fallbackSet: "standard" });
    const updated = await updateAgent(agent.id, { name: "Renamed" });
    assert.equal(updated!.name, "Renamed");
    assert.equal(updated!.fallbackSet, "standard");
  });
});
