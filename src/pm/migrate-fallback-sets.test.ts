// Tests for migrateToFallbackSets().
//
// Sets GATEWAY_PM_DIR to a temp directory so the file-backed JSON
// collections don't collide with real data or with other test files.
// Uses dynamic import() inside before() so the env var is visible
// before the module-level `new JsonCollection(pmPath("agents.json"))`
// calls run.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "migrate-test-"));

let agents: Awaited<typeof import("./agents.js")>["agents"];
let migrateToFallbackSets: Awaited<typeof import("./agents.js")>["migrateToFallbackSets"];
let createAgent: Awaited<typeof import("./agents.js")>["createAgent"];
let updateSettings: Awaited<typeof import("./project-settings.js")>["updateSettings"];
let getSettings: Awaited<typeof import("./project-settings.js")>["getSettings"];
let ROLE_DEFAULT_FALLBACK_SET: Awaited<typeof import("./prompts.js")>["ROLE_DEFAULT_FALLBACK_SET"];
let newId: Awaited<typeof import("./store.js")>["newId"];

before(async () => {
  process.env.GATEWAY_PM_DIR = testDir;
  const ag = await import("./agents.js");
  agents = ag.agents;
  migrateToFallbackSets = ag.migrateToFallbackSets;
  createAgent = ag.createAgent;
  const ps = await import("./project-settings.js");
  updateSettings = ps.updateSettings;
  getSettings = ps.getSettings;
  const prompts = await import("./prompts.js");
  ROLE_DEFAULT_FALLBACK_SET = prompts.ROLE_DEFAULT_FALLBACK_SET;
  const store = await import("./store.js");
  newId = store.newId;
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("migrateToFallbackSets()", () => {
  it("applies fallbackSet per ROLE_DEFAULT_FALLBACK_SET and resets pmConfigured", async () => {
    const pid = newId();
    // Seed project settings with pmConfigured=true so the migration resets it.
    await updateSettings(pid, { pmConfigured: true, pmLastRunAt: 1_700_000_000_000 });

    const engineer = await createAgent({
      projectId: pid, role: "engineer", name: "Test Engineer",
      providerKey: "anthropic", model: "claude-sonnet-5", createdBy: "system",
    });
    const qa = await createAgent({
      projectId: pid, role: "qa", name: "Test QA",
      providerKey: "anthropic", model: "claude-sonnet-5", createdBy: "system",
    });
    // Agent that already has a fallbackSet — must NOT be touched.
    const devops = await createAgent({
      projectId: pid, role: "devops", name: "Test DevOps",
      providerKey: "anthropic", model: "claude-sonnet-5",
      fallbackSet: "custom-set", createdBy: "system",
    });

    const migrated = await migrateToFallbackSets();

    assert.equal(migrated, 2, "migrates engineer + qa, skips devops with pre-existing fallbackSet");

    // (a) fallbackSet is set per ROLE_DEFAULT_FALLBACK_SET
    const eng2 = await agents.get(engineer.id);
    assert.equal(eng2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["engineer"], "engineer gets the role default");
    const qa2 = await agents.get(qa.id);
    assert.equal(qa2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["qa"], "qa gets the role default");

    // (b) pmConfigured is reset for the affected project
    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, false, "pmConfigured reset to false");
    assert.equal(settings.pmLastRunAt, null, "pmLastRunAt reset to null");

    // (c) Unaffected agent (already had fallbackSet) is unchanged
    const devops2 = await agents.get(devops.id);
    assert.equal(devops2?.fallbackSet, "custom-set", "pre-existing fallbackSet preserved");
  });

  it("returns 0 when all agents already have a fallbackSet", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });

    // All agents already have fallbackSet.
    await createAgent({
      projectId: pid, role: "engineer", name: "Already Migrated",
      providerKey: "anthropic", model: "claude-sonnet-5",
      fallbackSet: "standard", createdBy: "system",
    });

    const count = await migrateToFallbackSets();
    assert.equal(count, 0, "no agents should need migration");

    // pmConfigured should remain true (no agents were migrated, so no project reset).
    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, true, "pmConfigured not touched when nothing migrated");
  });

  it("handles an empty agent collection gracefully", async () => {
    const count = await migrateToFallbackSets();
    assert.equal(count, 0, "empty collection returns 0");
  });
});
