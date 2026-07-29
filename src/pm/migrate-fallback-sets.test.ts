// Tests for migrateToFallbackSets().
//
// Sets GATEWAY_PM_DIR to a temp directory so the file-backed JSON
// collections don't collide with real data or with other test files.
// Uses dynamic import() inside before() so the env var is visible
// before the module-level `new JsonCollection(pmPath("agents.json"))`
// calls run.
//
// The migration takes a GatewayConfig so it can look up fallback-set
// definitions and normalize providerKey/model to each agent's fallback
// set's first entry. The test config below uses three named sets — two
// with a single entry (for "primary pick" assertions) and one with two
// entries (for the "first entry wins" surface).
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config.js";

const testDir = mkdtempSync(join(tmpdir(), "migrate-test-"));

let agents: Awaited<typeof import("./agents.js")>["agents"];
let migrateToFallbackSets: Awaited<typeof import("./agents.js")>["migrateToFallbackSets"];
let createAgent: Awaited<typeof import("./agents.js")>["createAgent"];
let updateSettings: Awaited<typeof import("./project-settings.js")>["updateSettings"];
let getSettings: Awaited<typeof import("./project-settings.js")>["getSettings"];
let ROLE_DEFAULT_FALLBACK_SET: Awaited<typeof import("./prompts.js")>["ROLE_DEFAULT_FALLBACK_SET"];
let newId: Awaited<typeof import("./store.js")>["newId"];

// Test config: three fallback sets, deliberately different from the
// production defaults so the test is independent of any code change in
// prompts.ts. The first entry is what normalization will pin to.
const testConfig = {
  providers: {},
  openaiCompatibleInstances: {},
  fallbackSets: {
    "standard": {
      name: "Standard (test)",
      description: "test",
      providers: [{ provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" }],
    },
    "complex": {
      name: "Complex (test)",
      description: "test",
      providers: [{ provider: "anthropic", model: "claude-opus-5" }, { provider: "ollama", model: "qwen2.5:14b-q4_K_M" }],
    },
    "custom-set": {
      name: "Custom (test)",
      description: "test",
      providers: [{ provider: "anthropic", model: "claude-opus-5" }],
    },
  },
  tasks: {},
} as unknown as GatewayConfig;

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
  it("applies fallbackSet per ROLE_DEFAULT_FALLBACK_SET, normalizes primary pick, and resets pmConfigured", async () => {
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
    // Agent already has a fallbackSet -- primary pick still gets normalized
    // because the existing providerKey/model usually doesn't match the
    // set's first entry (the legacy "anthropic/claude-sonnet-5" default
    // is what's on disk from pre-pivot creation).
    const devops = await createAgent({
      projectId: pid, role: "devops", name: "Test DevOps",
      providerKey: "anthropic", model: "claude-sonnet-5",
      fallbackSet: "custom-set", createdBy: "system",
    });

    const migrated = await migrateToFallbackSets(testConfig);

    // All three agents needed an update: engineer + qa got a new
    // fallbackSet AND their primary pick normalized; devops kept its
    // fallbackSet but had its primary pick normalized to "custom-set"'s
    // first entry (anthropic/claude-opus-5).
    assert.equal(migrated, 3, "engineer + qa: assign + normalize; devops: normalize only");

    // (a) fallbackSet is set per ROLE_DEFAULT_FALLBACK_SET for the two
    // that were missing it.
    const eng2 = await agents.get(engineer.id);
    assert.equal(eng2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["engineer"], "engineer gets the role default");
    const qa2 = await agents.get(qa.id);
    assert.equal(qa2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["qa"], "qa gets the role default");

    // (a2) Primary pick normalized to the fallback set's first entry.
    // ROLE_DEFAULT_FALLBACK_SET["engineer"] and ["qa"] are "standard" in
    // the default prompts.ts; the test config's "standard" first entry is
    // ollama / qwen2.5:14b-instruct-q4_K_M.
    assert.equal(eng2?.providerKey, "ollama", "engineer primary pick = first entry provider");
    assert.equal(eng2?.model, "qwen2.5:14b-instruct-q4_K_M", "engineer primary pick = first entry model");
    assert.equal(qa2?.providerKey, "ollama", "qa primary pick = first entry provider");
    assert.equal(qa2?.model, "qwen2.5:14b-instruct-q4_K_M", "qa primary pick = first entry model");

    // (b) Devops primary pick was normalized to its set's first entry.
    const devops2 = await agents.get(devops.id);
    assert.equal(devops2?.fallbackSet, "custom-set", "pre-existing fallbackSet preserved");
    assert.equal(devops2?.providerKey, "anthropic", "devops primary pick = first entry provider");
    assert.equal(devops2?.model, "claude-opus-5", "devops primary pick = first entry model");

    // (c) pmConfigured is reset because at least one agent got a new
    // fallbackSet (engineer + qa). The devops normalization alone
    // wouldn't have triggered the reset, but the new fallbackSets were.
    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, false, "pmConfigured reset to false");
    assert.equal(settings.pmLastRunAt, null, "pmLastRunAt reset to null");
  });

  it("normalizes primary pick without resetting pmConfigured when fallbackSet was already set", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });

    // Agent has fallbackSet="standard" with stale primary pick that
    // doesn't match the set's first entry. Migration should normalize
    // the primary pick but NOT reset pmConfigured (no fallbackSet was
    // reassigned, so the PM has nothing to re-evaluate).
    const agent = await createAgent({
      projectId: pid, role: "engineer", name: "Already Migrated",
      providerKey: "anthropic", model: "claude-sonnet-5",
      fallbackSet: "standard", createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 1, "primary pick normalized even though fallbackSet was already set");

    const after = await agents.get(agent.id);
    assert.equal(after?.fallbackSet, "standard", "fallbackSet preserved");
    assert.equal(after?.providerKey, "ollama", "primary pick normalized to set's first entry provider");
    assert.equal(after?.model, "qwen2.5:14b-instruct-q4_K_M", "primary pick normalized to set's first entry model");

    // pmConfigured stays true because pure normalization doesn't affect
    // PM decisions.
    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, true, "pmConfigured not touched when fallbackSet unchanged");
  });

  it("is a no-op when primary pick already matches the fallback set's first entry", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });

    // Agent whose primary pick already matches "standard"'s first entry.
    const agent = await createAgent({
      projectId: pid, role: "engineer", name: "Already Normalized",
      providerKey: "ollama", model: "qwen2.5:14b-instruct-q4_K_M",
      fallbackSet: "standard", createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 0, "no agents need updating when primary pick already matches");

    const after = await agents.get(agent.id);
    assert.equal(after?.providerKey, "ollama", "providerKey unchanged");
    assert.equal(after?.model, "qwen2.5:14b-instruct-q4_K_M", "model unchanged");

    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, true, "pmConfigured not touched when nothing changed");
  });

  it("leaves providerKey/model untouched but resets pmConfigured when the agent's fallbackSet is no longer in config", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });
    const agent = await createAgent({
      projectId: pid, role: "engineer", name: "Orphaned Set",
      providerKey: "anthropic", model: "claude-sonnet-5",
      fallbackSet: "deleted-set", createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    // The agent has fallbackSet set so step 1 (assign role default) is
    // skipped — but step 2 (normalize) can't find "deleted-set" in the
    // test config, so the agent itself is left untouched. The orphanSet
    // branch still flips pmConfigured so the PM re-runs and picks a
    // valid set; otherwise the agent would dispatch to a non-existent
    // set indefinitely and the runtime would 503 on every request.
    assert.equal(count, 0, "no agent updates -- the agent's own fields are stale, not migrated");

    const after = await agents.get(agent.id);
    assert.equal(after?.providerKey, "anthropic", "providerKey unchanged");
    assert.equal(after?.model, "claude-sonnet-5", "model unchanged");
    assert.equal(after?.fallbackSet, "deleted-set", "fallbackSet unchanged");

    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, false, "pmConfigured reset so the PM re-evaluates and picks a valid set");
  });

  it("handles an empty agent collection gracefully", async () => {
    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 0, "empty collection returns 0");
  });
});
