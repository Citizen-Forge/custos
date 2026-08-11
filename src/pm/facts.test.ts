// Tests for the facts gatekeeper: proposeFact/approveFact/rejectFact plus
// the pending/approved split in listFacts/listApprovedFacts/listPendingFacts.
//
// Sets GATEWAY_PM_DIR to a temp directory so the file-backed JSON
// collection doesn't collide with real data or with other test files.
// Uses dynamic import() inside before() so the env var is visible before
// the module-level `new JsonCollection(pmPath("project-facts.json"))` call
// runs -- same pattern as migrate-fallback-sets.test.ts.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let writeFact: Awaited<typeof import("./facts.js")>["writeFact"];
let proposeFact: Awaited<typeof import("./facts.js")>["proposeFact"];
let approveFact: Awaited<typeof import("./facts.js")>["approveFact"];
let rejectFact: Awaited<typeof import("./facts.js")>["rejectFact"];
let listFacts: Awaited<typeof import("./facts.js")>["listFacts"];
let listApprovedFacts: Awaited<typeof import("./facts.js")>["listApprovedFacts"];
let listPendingFacts: Awaited<typeof import("./facts.js")>["listPendingFacts"];
let newId: Awaited<typeof import("./store.js")>["newId"];

const testDir = mkdtempSync(join(tmpdir(), "facts-test-"));

before(async () => {
  process.env.GATEWAY_PM_DIR = testDir;
  const f = await import("./facts.js");
  writeFact = f.writeFact;
  proposeFact = f.proposeFact;
  approveFact = f.approveFact;
  rejectFact = f.rejectFact;
  listFacts = f.listFacts;
  listApprovedFacts = f.listApprovedFacts;
  listPendingFacts = f.listPendingFacts;
  const store = await import("./store.js");
  newId = store.newId;
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("facts gatekeeper", () => {
  it("writeFact is immediately approved and visible", async () => {
    const pid = newId();
    await writeFact({ projectId: pid, key: "repo.url", value: "https://example.com/repo" });

    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].status, "approved");
    assert.equal((await listPendingFacts(pid)).length, 0);
  });

  it("proposeFact lands in the pending pile, invisible to listApprovedFacts", async () => {
    const pid = newId();
    await proposeFact({ projectId: pid, key: "decision.retries", value: "3 attempts", writtenBy: "agent-1", writtenByLabel: "Engineer" });

    assert.equal((await listApprovedFacts(pid)).length, 0, "not approved yet");
    const pending = await listPendingFacts(pid);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal((await listFacts(pid)).length, 1, "still visible in the unfiltered admin view");
  });

  it("re-proposing the same key while pending updates the same row instead of stacking duplicates", async () => {
    const pid = newId();
    const first = await proposeFact({ projectId: pid, key: "test.command", value: "npm test" });
    const second = await proposeFact({ projectId: pid, key: "test.command", value: "npm run test:ci" });

    assert.equal(first.id, second.id, "same pending row reused");
    const pending = await listPendingFacts(pid);
    assert.equal(pending.length, 1, "no duplicate pending rows");
    assert.equal(pending[0].value, "npm run test:ci");
  });

  it("proposing a key that already has an approved fact does not touch the approved value", async () => {
    const pid = newId();
    await writeFact({ projectId: pid, key: "repo.url", value: "https://example.com/original" });
    await proposeFact({ projectId: pid, key: "repo.url", value: "https://example.com/proposed-change" });

    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].value, "https://example.com/original", "approved row untouched by the pending proposal");

    const pending = await listPendingFacts(pid);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].value, "https://example.com/proposed-change");
  });

  it("approveFact promotes a pending proposal and removes it from the pending pile", async () => {
    const pid = newId();
    const proposed = await proposeFact({ projectId: pid, key: "convention.branching", value: "trunk-based" });

    const approved = await approveFact(proposed.id);
    assert.ok(approved);
    assert.equal(approved!.status, "approved");
    assert.equal(approved!.key, "convention.branching");

    assert.equal((await listPendingFacts(pid)).length, 0, "pending row consumed");
    const approvedList = await listApprovedFacts(pid);
    assert.equal(approvedList.length, 1);
    assert.equal(approvedList[0].value, "trunk-based");
  });

  it("approveFact upserts into an existing approved row under the same key", async () => {
    const pid = newId();
    await writeFact({ projectId: pid, key: "repo.url", value: "https://example.com/stale" });
    const proposed = await proposeFact({ projectId: pid, key: "repo.url", value: "https://example.com/fresh" });

    await approveFact(proposed.id);

    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1, "still one row for the key, not two");
    assert.equal(approved[0].value, "https://example.com/fresh");
  });

  it("approveFact supports overrides to merge a proposal into a different key", async () => {
    const pid = newId();
    const proposed = await proposeFact({ projectId: pid, key: "decision.capacity-2026-07-25", value: "raised to 5 engineers" });

    const approved = await approveFact(proposed.id, { key: "decision.capacity", value: "5 engineers max" });
    assert.ok(approved);
    assert.equal(approved!.key, "decision.capacity");
    assert.equal(approved!.value, "5 engineers max");

    const approvedList = await listApprovedFacts(pid);
    assert.equal(approvedList.length, 1);
    assert.equal(approvedList[0].key, "decision.capacity");
  });

  it("rejectFact discards the pending row without touching an approved fact under the same key", async () => {
    const pid = newId();
    await writeFact({ projectId: pid, key: "repo.url", value: "https://example.com/kept" });
    const proposed = await proposeFact({ projectId: pid, key: "repo.url", value: "https://example.com/bad-proposal" });

    const removed = await rejectFact(proposed.id);
    assert.equal(removed, true);

    assert.equal((await listPendingFacts(pid)).length, 0);
    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].value, "https://example.com/kept", "approved fact survives the rejected proposal");
  });

  it("approveFact and rejectFact return null/false for a non-pending id", async () => {
    const pid = newId();
    const approvedFact = await writeFact({ projectId: pid, key: "repo.url", value: "https://example.com" });

    assert.equal(await approveFact(approvedFact.id), null, "already-approved id is not a pending fact");
    assert.equal(await rejectFact(approvedFact.id), false, "already-approved id is not a pending fact");
    assert.equal(await approveFact("nonexistent-id"), null);
    assert.equal(await rejectFact("nonexistent-id"), false);

    // Untouched by the no-op rejects/approves above.
    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].value, "https://example.com");
  });

  it("rows written before the status field existed are treated as approved", async () => {
    const pid = newId();
    const fact = await writeFact({ projectId: pid, key: "legacy.fact", value: "pre-gatekeeper row" });
    // Simulate an old on-disk row that predates the status field.
    delete (fact as { status?: string }).status;
    const { JsonCollection, pmPath } = await import("./store.js");
    const raw = new JsonCollection<{ id: string; status?: string }>(pmPath("project-facts.json"));
    await raw.update(fact.id, (row) => {
      delete row.status;
    });

    const approved = await listApprovedFacts(pid);
    assert.equal(approved.length, 1, "status-less legacy row still counts as approved");
    assert.equal((await listPendingFacts(pid)).length, 0);
  });
});
