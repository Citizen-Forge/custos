// Tests for migrateToFallbackSets().
//
// Sets GATEWAY_PM_DIR to a temp directory so the file-backed JSON
// collections don't collide with real data or with other test files.
// Uses dynamic import() inside before() so the env var is visible
// before the module-level `new JsonCollection(pmPath("agents.json"))`
// calls run.
//
// The migration takes a GatewayConfig so it can look up fallback-set
// definitions and apply role defaults. With the schema cleanup dropping
// `providerKey`/`model` from AgentDef, the test fixtures seed agents
// with `fallbackSet` only and assertions about the operator-facing
// "primary pick" use `primaryPick(agent, config)` rather than reading
// `agent.providerKey` / `agent.model` (which no longer exist on the
// type).
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
let primaryPick: Awaited<typeof import("./agents.js")>["primaryPick"];
let updateSettings: Awaited<typeof import("./project-settings.js")>["updateSettings"];
let getSettings: Awaited<typeof import("./project-settings.js")>["getSettings"];
let ROLE_DEFAULT_FALLBACK_SET: Awaited<typeof import("./prompts.js")>["ROLE_DEFAULT_FALLBACK_SET"];
let newId: Awaited<typeof import("./store.js")>["newId"];

// Test config: three fallback sets, deliberately different from the
// production defaults so the test is independent of any code change in
// prompts.ts. The first entry is what primaryPick returns.
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
  primaryPick = ag.primaryPick;
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
  it("applies fallbackSet per ROLE_DEFAULT_FALLBACK_SET and resets pmConfigured for agents missing one", async () => {
    const pid = newId();
    // Seed project settings with pmConfigured=true so the migration resets it.
    await updateSettings(pid, { pmConfigured: true, pmLastRunAt: 1_700_000_000_000 });

    const engineer = await createAgent({
      projectId: pid, role: "engineer", name: "Test Engineer", createdBy: "system",
    });
    const qa = await createAgent({
      projectId: pid, role: "qa", name: "Test QA", createdBy: "system",
    });
    // Devops already has fallbackSet pointing at a valid set in config.
    // Migration sees fallbackSet is set and the set exists with
    // providers, so it skips the agent entirely.
    const devops = await createAgent({
      projectId: pid, role: "devops", name: "Test DevOps",
      fallbackSet: "custom-set", createdBy: "system",
    });

    const migrated = await migrateToFallbackSets(testConfig);

    // Engineer + qa got a new fallbackSet; devops was already correct.
    assert.equal(migrated, 2, "engineer + qa got fallbackSet, devops was already correct");

    // (a) fallbackSet is set per ROLE_DEFAULT_FALLBACK_SET for the two
    // that were missing it.
    const eng2 = await agents.get(engineer.id);
    assert.equal(eng2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["engineer"], "engineer gets the role default");
    const qa2 = await agents.get(qa.id);
    assert.equal(qa2?.fallbackSet, ROLE_DEFAULT_FALLBACK_SET["qa"], "qa gets the role default");

    // (b) Primary pick derives from fallbackSet[0], not from any
    // stored field on the agent. ROLE_DEFAULT_FALLBACK_SET["engineer"]
    // and ["qa"] are "standard" in the default prompts.ts; the test
    // config's "standard" first entry is ollama / qwen2.5:14b-instruct-q4_K_M.
    assert.deepEqual(primaryPick(eng2!, testConfig), { providerKey: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" });
    assert.deepEqual(primaryPick(qa2!, testConfig), { providerKey: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" });

    // (c) Devops is untouched because its fallbackSet was already set
    // and the set exists in config.
    const devops2 = await agents.get(devops.id);
    assert.equal(devops2?.fallbackSet, "custom-set", "pre-existing fallbackSet preserved");
    assert.deepEqual(primaryPick(devops2!, testConfig), { providerKey: "anthropic", model: "claude-opus-5" });

    // (d) pmConfigured is reset because at least one agent got a new
    // fallbackSet (engineer + qa).
    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, false, "pmConfigured reset to false");
    assert.equal(settings.pmLastRunAt, null, "pmLastRunAt reset to null");
  });

  it("is a no-op when fallbackSet is already set to a valid entry", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });

    const agent = await createAgent({
      projectId: pid, role: "engineer", name: "Already Migrated",
      fallbackSet: "standard", createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 0, "no agents need updating when fallbackSet is already valid");

    const after = await agents.get(agent.id);
    assert.equal(after?.fallbackSet, "standard", "fallbackSet preserved");

    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, true, "pmConfigured not touched when nothing changed");
  });

  it("clears fallbackSet and resets pmConfigured when the agent's fallbackSet is no longer in config", async () => {
    const pid = newId();
    await updateSettings(pid, { pmConfigured: true });
    const agent = await createAgent({
      projectId: pid, role: "engineer", name: "Orphaned Set",
      fallbackSet: "deleted-set", createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 1, "orphan agent's fallbackSet is cleared");

    const after = await agents.get(agent.id);
    assert.equal(after?.fallbackSet, undefined, "orphan fallbackSet cleared so the PM can re-evaluate");
    assert.equal(primaryPick(after!, testConfig), null, "no primary pick until PM assigns a fresh set");

    const settings = await getSettings(pid);
    assert.equal(settings.pmConfigured, false, "pmConfigured reset so the PM re-runs and picks a valid set");
  });

  it("assigns global system roles through GLOBAL_AGENT_FALLBACK_SET when no fallbackSet is set", async () => {
    // Seed an "embeddings" global with no fallbackSet. Migration should
    // fill it from GLOBAL_AGENT_FALLBACK_SET.embeddings (which is
    // "standard"), so the primary pick becomes that set's first entry.
    const agent = await createAgent({
      projectId: null,
      kind: "global",
      systemRole: "embeddings",
      role: "engineer",
      name: "Test Embeddings",
      createdBy: "system",
    });

    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 1, "global agent without fallbackSet gets one assigned");

    const after = await agents.get(agent.id);
    assert.equal(after?.fallbackSet, "standard", "global agent gets the role-default fallback set");
    assert.deepEqual(primaryPick(after!, testConfig), { providerKey: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" });
  });

  it("handles an empty agent collection gracefully", async () => {
    const count = await migrateToFallbackSets(testConfig);
    assert.equal(count, 0, "empty collection returns 0");
  });
});