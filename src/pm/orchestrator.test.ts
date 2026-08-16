// Behavior-pinning safety net for orchestrator.ts, written BEFORE splitting
// it into concern-separated modules (see the planned src/pm/orchestrator/
// split). orchestrator.ts had zero test coverage despite being the piece
// that turns board state into live agent dispatch on a production instance
// -- these tests exist so a mechanical extraction that changes behavior
// (drops a guard, mis-wires a closure, loses the unavailable/failure
// distinction) fails loudly instead of shipping silently.
//
// Strategy: board/ideas/agents/runs/project-settings/facts are exercised
// for REAL against a temp GATEWAY_PM_DIR (same pattern as facts.test.ts) --
// they're cheap, deterministic, file-backed, and asserting against real
// persisted state is more convincing than asserting against a mock's call
// log. The genuinely external dependencies (spawning a `claude` subprocess
// via runAgent, real Slack HTTP calls, real `gh`/git operations) are
// replaced via node:test's mock.module(), which requires
// --experimental-test-module-mocks (wired into the `test` npm script).
//
// mock.module's exports option REPLACES a module's exports wholesale, not
// per-key -- every named export orchestrator.ts imports from a mocked
// module must be present here even where a test doesn't care about it.
// @types/node types this option as `namedExports` (the runtime also
// accepts the newer `exports` name, with a deprecation warning) -- using
// the typed name avoids both the type error and the warning.
import { before, after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace, PrGateBlockKind } from "./worktrees.js";
import type { ActivityMessage } from "./orchestrator.js";
import type { SlackMessage } from "../slack/client.js";
import type { SlackPersona } from "../slack/personas.js";

const pmDir = mkdtempSync(join(tmpdir(), "orch-pm-"));
const projectsPath = join(mkdtempSync(join(tmpdir(), "orch-projfile-")), "projects.json");
const workspaceRoot = mkdtempSync(join(tmpdir(), "orch-ws-"));

process.env.GATEWAY_PM_DIR = pmDir;
process.env.GATEWAY_PROJECTS_PATH = projectsPath;
process.env.CUSTOS_WORKSPACE_DIR = workspaceRoot;

after(() => {
  rmSync(pmDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fakes --

type AnyFn = (...args: any[]) => any;

/** Every dispatch method's `runAgent` call is routed through this single
 *  mutable slot so each test can install its own scripted response without
 *  re-mocking the module. Defaults to a hard failure so a test that forgets
 *  to configure it fails fast and loud rather than hanging on a real spawn. */
let runAgentImpl: AnyFn = async () => {
  throw new Error("runAgentImpl not configured for this test");
};
mock.module("./agent-runner.js", {
  namedExports: {
    runAgent: (...args: unknown[]) => runAgentImpl(...args),
  },
});

// board.ts, pm-prompts.ts (etc.) import their own unrelated named exports
// from these same modules -- mock.module's exports replaces the module
// wholesale, so every real export is spread through first and only the
// ones this suite actually wants to control are overridden, keeping every
// OTHER real module in the dependency graph (board.ts's `redactSecrets`,
// pm-prompts.ts's `listSecrets`, etc.) working unmodified.
interface WorktreesImpl {
  isGitRepo(dir: string): Promise<boolean>;
  ensureWorkspace(projectDir: string, projectId: string, item: { id: string; type: string; title: string }, defaultBranch: string): Promise<Workspace>;
  releaseWorkspace(projectDir: string, projectId: string, itemId: string): Promise<void>;
  verifyGitHubAccess(cwd: string, env: Record<string, string>): Promise<{ ok: true } | { ok: false; reason: string }>;
  verifyPullRequest(cwd: string, prUrl: string, branch: string, defaultBranch: string, env: Record<string, string>): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
  checkPrReadyToMerge(cwd: string, prUrl: string, env: Record<string, string>): Promise<{ ready: true } | { ready: false; kind: PrGateBlockKind; reason: string }>;
  mergePullRequest(cwd: string, prUrl: string, env: Record<string, string>): Promise<{ ok: true } | { ok: false; reason: string }>;
}
const realWorktrees = await import("./worktrees.js");
const worktreesDefault: WorktreesImpl = {
  isGitRepo: async () => false,
  ensureWorkspace: async (projectDir) => ({ cwd: projectDir, branch: null, isolated: false }),
  releaseWorkspace: async () => {},
  verifyGitHubAccess: async () => ({ ok: true }),
  verifyPullRequest: async (_cwd, prUrl) => ({ ok: true, url: prUrl }),
  checkPrReadyToMerge: async () => ({ ready: true }),
  mergePullRequest: async () => ({ ok: true }),
};
let worktreesImpl: WorktreesImpl = { ...worktreesDefault };
mock.module("./worktrees.js", {
  namedExports: {
    ...realWorktrees,
    isGitRepo: (dir: string) => worktreesImpl.isGitRepo(dir),
    ensureWorkspace: (projectDir: string, projectId: string, item: { id: string; type: string; title: string }, defaultBranch: string) =>
      worktreesImpl.ensureWorkspace(projectDir, projectId, item, defaultBranch),
    releaseWorkspace: (projectDir: string, projectId: string, itemId: string) => worktreesImpl.releaseWorkspace(projectDir, projectId, itemId),
    verifyGitHubAccess: (cwd: string, env: Record<string, string>) => worktreesImpl.verifyGitHubAccess(cwd, env),
    verifyPullRequest: (cwd: string, prUrl: string, branch: string, defaultBranch: string, env: Record<string, string>) =>
      worktreesImpl.verifyPullRequest(cwd, prUrl, branch, defaultBranch, env),
    checkPrReadyToMerge: (cwd: string, prUrl: string, env: Record<string, string>) => worktreesImpl.checkPrReadyToMerge(cwd, prUrl, env),
    mergePullRequest: (cwd: string, prUrl: string, env: Record<string, string>) => worktreesImpl.mergePullRequest(cwd, prUrl, env),
  },
});

interface VaultImpl {
  hasGitCredentials(projectId: string): Promise<boolean>;
  resolveAgentEnv(projectId: string): Promise<Record<string, string>>;
}
const realVault = await import("./vault.js");
const vaultDefault: VaultImpl = {
  hasGitCredentials: async () => true,
  resolveAgentEnv: async () => ({}),
};
let vaultImpl: VaultImpl = { ...vaultDefault };
mock.module("./vault.js", {
  namedExports: {
    ...realVault,
    hasGitCredentials: (projectId: string) => vaultImpl.hasGitCredentials(projectId),
    resolveAgentEnv: (projectId: string) => vaultImpl.resolveAgentEnv(projectId),
  },
});

interface SlackClientImpl {
  fetchNewMessages(botToken: string, channel: string, oldestTs: string | null): Promise<{ ok: true; messages: SlackMessage[] } | { ok: false; error: string }>;
  fetchUserName(botToken: string, userId: string): Promise<string | null>;
  postMessage(botToken: string, channel: string, text: string, persona: SlackPersona, threadTs?: string): Promise<{ ok: true; ts: string } | { ok: false; error: string }>;
  resolveBotUserId(botToken: string): Promise<string | null>;
}
// isPlainHumanMessage/stripBotMention are pure (no I/O) -- passed through
// from the real module untouched, so the Slack mention branch is exercised
// against real string-matching logic, not a stand-in.
const realSlackClient = await import("../slack/client.js");
const slackDefault: SlackClientImpl = {
  fetchNewMessages: async () => ({ ok: true, messages: [] }),
  fetchUserName: async () => null,
  postMessage: async () => ({ ok: true, ts: "1.0" }),
  resolveBotUserId: async () => "UBOT",
};
let slackImpl: SlackClientImpl = { ...slackDefault };
mock.module("../slack/client.js", {
  namedExports: {
    ...realSlackClient,
    fetchNewMessages: (botToken: string, channel: string, oldestTs: string | null) => slackImpl.fetchNewMessages(botToken, channel, oldestTs),
    fetchUserName: (botToken: string, userId: string) => slackImpl.fetchUserName(botToken, userId),
    postMessage: (botToken: string, channel: string, text: string, persona: SlackPersona, threadTs?: string) => slackImpl.postMessage(botToken, channel, text, persona, threadTs),
    resolveBotUserId: (botToken: string) => slackImpl.resolveBotUserId(botToken),
  },
});

let statusReplyImpl: AnyFn = async () => "status reply";
mock.module("../slack/status.js", {
  namedExports: {
    buildStatusReply: (...args: unknown[]) => statusReplyImpl(...args),
  },
});

// ------------------------------------------------------------- modules --

const { newId } = await import("./store.js");
const projectsMod = await import("../remote/projects.js");
const board = await import("./board.js");
const ideas = await import("./ideas.js");
const agentStore = await import("./agents.js");
const runs = await import("./runs.js");
const settingsMod = await import("./project-settings.js");
const factsMod = await import("./facts.js");
const pmTools = await import("../mcp/pm-tools.js");
const { Orchestrator } = await import("./orchestrator.js");
type OrchestratorT = InstanceType<typeof Orchestrator>;
type Project = Awaited<ReturnType<typeof projectsMod.createProject>>;

// ------------------------------------------------------------- fixtures --

// A fresh object per call -- sharing one fakeRuntime across tests meant a
// test that overrode e.g. spendTracker.getProjectSpend permanently mutated
// it for every orchestrator created afterwards, in every later test.
let spendTrackerImpl = { getProjectSpend: async (_projectId: string) => 0 };
function makeOrchestrator(): OrchestratorT {
  const runtime = {
    globalQueue: null,
    config: { fallbackSets: {}, slack: { botToken: "xoxb-test", enabled: true } },
    spendTracker: { getProjectSpend: (id: string) => spendTrackerImpl.getProjectSpend(id) },
  } as unknown as ConstructorParameters<typeof Orchestrator>[0];
  return new Orchestrator(runtime);
}

async function makeProject(): Promise<Project> {
  return projectsMod.createProject(`proj-${newId()}`);
}

/** CreateWorkItemInput has no `prUrl` field (only updateWorkItem's
 *  WorkItemPatch does) -- passing it straight through to createWorkItem
 *  silently drops it, so it's split out and applied as a follow-up patch. */
async function makeTicket(
  projectId: string,
  overrides: Partial<Parameters<typeof board.createWorkItem>[0]> & { prUrl?: string } = {},
) {
  const { prUrl, ...createFields } = overrides;
  const item = await board.createWorkItem({ projectId, type: "story", title: "Test ticket", ...createFields });
  if (prUrl !== undefined) {
    const patched = await board.updateWorkItem(item.id, { prUrl });
    return patched!;
  }
  return item;
}

/** Reads the mcpConfig JSON a toolDriven runAgent call was given and returns
 *  the bearer token, so a scripted runAgentImpl can reach into the real
 *  (unmocked) pm-tools.ts session map and simulate what a tool call
 *  (record_fact, report_ready_for_qa, promote_ticket, ...) would have done. */
function tokenFromMcpConfig(mcpConfig: string): string {
  const parsed = JSON.parse(mcpConfig) as { mcpServers: { custos_pm: { headers: { Authorization: string } } } };
  return parsed.mcpServers.custos_pm.headers.Authorization.replace("Bearer ", "");
}

/** tickProject fires several stages (assignModels, groomBacklog, planIdea,
 *  ...) via `void this.stage(...)` rather than awaiting them -- by design,
 *  so one project's slow dispatch can't block every other project's tick.
 *  That means `await orch.tick()` only guarantees each stage was STARTED,
 *  not finished. Tests that need to observe a stage's outcome poll
 *  activeKeys() down to empty instead of assuming tick() already waited. */
async function waitUntilIdle(orch: OrchestratorT, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (orch.activeKeys().length > 0) {
    if (Date.now() - start > timeoutMs) throw new Error(`orchestrator still busy after ${timeoutMs}ms: ${orch.activeKeys().join(", ")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function collectEvents(orch: OrchestratorT) {
  // .text is the third-person line every existing assertion here already
  // matches against -- unchanged by ActivityMessage's introduction. A
  // separate helper (collectSlackEvents) exists below for tests that
  // specifically need .slackText/.agent.
  const activity: string[] = [];
  const changed: string[] = [];
  orch.on("activity", (_pid, msg) => activity.push(msg.text));
  orch.on("change", (pid) => changed.push(pid));
  return { activity, changed };
}

/** Full ActivityMessage capture, for tests asserting on Slack-specific
 *  attribution (slackText/agent) rather than just the UI-facing text. */
function collectActivityMessages(orch: OrchestratorT) {
  const messages: ActivityMessage[] = [];
  orch.on("activity", (_pid, msg) => messages.push(msg));
  return messages;
}

beforeEach(() => {
  runAgentImpl = async () => {
    throw new Error("runAgentImpl not configured for this test");
  };
  worktreesImpl = { ...worktreesDefault };
  vaultImpl = { ...vaultDefault };
  slackImpl = { ...slackDefault };
  statusReplyImpl = async () => "status reply";
  spendTrackerImpl = { getProjectSpend: async () => 0 };
});

// ------------------------------------------------------------------------

describe("guard(): dispatch isolation", () => {
  it("a second call for the same key while one is in flight is a no-op", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    let calls = 0;
    runAgentImpl = async () => {
      calls++;
      return { ok: true, unavailable: false, error: null, parsed: null, text: "", costUsd: null, runMs: 0, runId: "r1" };
    };
    const orch = makeOrchestrator();
    // guard() sets the busy key SYNCHRONOUSLY the instant groomBacklog is
    // called (before its first await), so calling it twice back-to-back
    // with no await in between guarantees the second call observes the
    // first one's busy entry, regardless of how long the first call's own
    // chain (real fs I/O via resolveProjectAgent) actually takes.
    const first = orch.groomBacklog(project.id);
    const second = orch.groomBacklog(project.id);
    await Promise.all([first, second]);
    assert.equal(calls, 1, "only the first call should have dispatched");
  });

  it("an unexpected throw inside the guarded function is swallowed and reported via activity, not propagated", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    runAgentImpl = async () => {
      throw new Error("boom: unexpected raw throw");
    };
    await assert.doesNotReject(orch.groomBacklog(project.id));
    assert.ok(activity.some((m) => m.includes("failed unexpectedly") && m.includes("boom")), `expected an unexpected-failure activity line, got: ${JSON.stringify(activity)}`);
  });
});

describe("pauseProject / resumeProject", () => {
  it("pause aborts in-flight work scoped to the project and stops emitting further activity from it", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    const orch = makeOrchestrator();
    let sawAbort = false;
    runAgentImpl = (_runtime: unknown, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          sawAbort = true;
          reject(new Error("aborted"));
        };
        // The signal can already be aborted by the time this executor
        // runs (pauseProject racing ahead of groomBacklog's own awaits
        // before it reaches the runAgent call) -- addEventListener alone
        // would never fire in that case since EventTarget doesn't replay
        // past events to a listener added after the fact.
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort);
      });
    const inFlight = orch.groomBacklog(project.id);
    const aborted = await orch.pauseProject(project.id);
    await inFlight;
    assert.equal(aborted, 1);
    assert.equal(sawAbort, true);
  });

  it("resumeProject clears the paused flag", async () => {
    const project = await makeProject();
    const orch = makeOrchestrator();
    await orch.pauseProject(project.id);
    assert.equal((await settingsMod.getSettings(project.id)).paused, true);
    await orch.resumeProject(project.id);
    assert.equal((await settingsMod.getSettings(project.id)).paused, false);
  });
});

describe("groomBacklog", () => {
  it("no-ops when the backlog is empty (no agent dispatch)", async () => {
    const project = await makeProject();
    const orch = makeOrchestrator();
    let called = false;
    runAgentImpl = async () => { called = true; return {}; };
    await orch.groomBacklog(project.id);
    assert.equal(called, false);
  });

  it("a tool-driven success updates lastGroomSignal to the post-pass fingerprint", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    const orch = makeOrchestrator();
    runAgentImpl = async () => ({ ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" });
    await orch.groomBacklog(project.id);
    const settings = await settingsMod.getSettings(project.id);
    assert.notEqual(settings.lastGroomSignal, null);
  });

  it("a real failure (not unavailable) emits an activity line", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    runAgentImpl = async () => ({ ok: false, unavailable: false, parsed: null, error: "provider exploded", text: "", costUsd: null, runMs: 0, runId: "r1" });
    await orch.groomBacklog(project.id);
    assert.ok(activity.some((m) => m.includes("grooming failed") && m.includes("provider exploded")));
  });

  it("an 'unavailable' failure (routine concurrency contention) emits no activity at all", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    runAgentImpl = async () => ({ ok: false, unavailable: true, parsed: null, error: null, text: "", costUsd: null, runMs: 0, runId: "r1" });
    await orch.groomBacklog(project.id);
    assert.deepEqual(activity, []);
  });

  it("tool actions recorded on the groom session surface as one combined activity line", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog", title: "Promote me" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token);
      session!.actions.push('promoted "Promote me" to ready');
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    await orch.groomBacklog(project.id);
    assert.ok(activity.some((m) => m.startsWith("Product owner:") && m.includes('promoted "Promote me" to ready')));
  });
});

describe("curateFacts", () => {
  it("no-ops when there are no pending facts", async () => {
    const project = await makeProject();
    const orch = makeOrchestrator();
    let called = false;
    runAgentImpl = async () => { called = true; return {}; };
    await orch.curateFacts(project.id);
    assert.equal(called, false);
  });

  it("success updates lastCurateSignal", async () => {
    const project = await makeProject();
    await factsMod.proposeFact({ projectId: project.id, key: "k", value: "v" });
    const orch = makeOrchestrator();
    runAgentImpl = async () => ({ ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" });
    await orch.curateFacts(project.id);
    const settings = await settingsMod.getSettings(project.id);
    assert.notEqual(settings.lastCurateSignal, null);
  });
});

describe("assignReady", () => {
  it("no-ops when there is no ready work", async () => {
    const project = await makeProject();
    const orch = makeOrchestrator();
    let called = false;
    runAgentImpl = async () => { called = true; return {}; };
    await orch.assignReady(project.id);
    assert.equal(called, false);
  });

  it("success updates lastAssignSignal to the post-pass fingerprint incl. inFlight count", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "ready" });
    const orch = makeOrchestrator();
    runAgentImpl = async () => ({ ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" });
    await orch.assignReady(project.id);
    const settings = await settingsMod.getSettings(project.id);
    assert.match(settings.lastAssignSignal ?? "", /\|inFlight=0$/);
  });
});

describe("pollSlackIdeas", () => {
  it("first poll seeds the cursor at 'now' and creates no ideas from channel history", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { slackChannelId: "C123" });
    let fetchCalled = false;
    slackImpl.fetchNewMessages = async () => { fetchCalled = true; return { ok: true, messages: [] }; };
    const orch = makeOrchestrator();
    await orch.pollSlackIdeas(project.id);
    assert.equal(fetchCalled, false, "first poll must not import channel backlog");
    const settings = await settingsMod.getSettings(project.id);
    assert.notEqual(settings.slackLastSeenTs, null);
    assert.equal((await ideas.listIdeas(project.id)).length, 0);
  });

  it("a plain human message becomes an inbox idea", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { slackChannelId: "C123", slackLastSeenTs: "100.0" });
    slackImpl.fetchNewMessages = async () => ({
      ok: true,
      messages: [{ type: "message", user: "U1", text: "we should add dark mode", ts: "200.0" }],
    });
    slackImpl.fetchUserName = async () => "Alex";
    const orch = makeOrchestrator();
    const { changed } = collectEvents(orch);
    await orch.pollSlackIdeas(project.id);
    const created = await ideas.listIdeas(project.id);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "we should add dark mode");
    assert.match(created[0].brief, /Posted in Slack by Alex/);
    assert.equal((await settingsMod.getSettings(project.id)).slackLastSeenTs, "200.0");
    // guard() itself emits "change" on entry and on exit regardless of
    // outcome, on top of pollSlackIdeas's own emit when it creates an
    // idea -- assert a change was seen for the right project, not an
    // exact count that's really guard()'s bookkeeping, not this test's.
    assert.ok(changed.length >= 1 && changed.every((id) => id === project.id));
  });

  it("a message that @-mentions the bot gets a status reply in-thread and creates no idea", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { slackChannelId: "C123", slackLastSeenTs: "100.0" });
    slackImpl.fetchNewMessages = async () => ({
      ok: true,
      messages: [{ type: "message", user: "U1", text: "<@UBOT> what's in progress?", ts: "200.0" }],
    });
    let posted: { channel: string; text: string; threadTs?: string } | null = null;
    slackImpl.postMessage = async (_token: string, channel: string, text: string, _persona: unknown, threadTs?: string) => {
      posted = { channel, text, threadTs };
      return { ok: true, ts: "201.0" };
    };
    statusReplyImpl = async () => "3 in progress, 1 in QA";
    const orch = makeOrchestrator();
    await orch.pollSlackIdeas(project.id);
    assert.equal((await ideas.listIdeas(project.id)).length, 0, "a mention must not become an idea");
    assert.ok(posted, "expected a status reply to be posted");
    const p = posted as { channel: string; text: string; threadTs?: string };
    assert.equal(p.channel, "C123");
    assert.equal(p.threadTs, "200.0");
    assert.equal(p.text, "3 in progress, 1 in QA");
  });

  it("does nothing when Slack isn't configured on the project", async () => {
    const project = await makeProject();
    let fetchCalled = false;
    slackImpl.fetchNewMessages = async () => { fetchCalled = true; return { ok: true, messages: [] }; };
    const orch = makeOrchestrator();
    await orch.pollSlackIdeas(project.id);
    assert.equal(fetchCalled, false);
  });
});

describe("runEngineer", () => {
  async function setup() {
    const project = await makeProject();
    const agent = await agentStore.createAgent({ projectId: project.id, role: "engineer", name: "Eng", fallbackSet: "default" });
    const ticket = await makeTicket(project.id, { status: "in_progress" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: agent.id });
    return { project, agent, ticket };
  }

  it("holds the ticket with a synthetic failed run when the project has no usable git credentials", async () => {
    const { project, ticket } = await setup();
    // ensureWorkspace, not isGitRepo, is what runEngineer actually reads
    // (isGitRepo only backs engineerLimit's concurrency clamp elsewhere).
    worktreesImpl.ensureWorkspace = async (projectDir: string) => ({ cwd: projectDir, branch: "custos/x", isolated: true });
    vaultImpl.hasGitCredentials = async () => false;
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    assert.ok(activity.some((m) => m.includes("no project secret is marked for Git use")));
    const runsList = await runs.listRuns(project.id);
    assert.equal(runsList.length, 1);
    assert.equal(runsList[0].status, "failed");
    assert.equal(runsList[0].billed, false);
    const freshTicket = await board.getWorkItem(ticket.id);
    assert.equal(freshTicket!.attempts, 1);
  });

  it("a 'blocked' outcome clears attempts, releases the workspace, and sends the ticket back to backlog", async () => {
    const { project, ticket } = await setup();
    await board.recordAttemptFailure(ticket.id); // pre-existing attempts should be cleared
    let released = false;
    worktreesImpl.releaseWorkspace = async () => { released = true; };
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { status: "blocked", reason: "needs a product decision on X", followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    assert.ok(activity.some((m) => m.includes("is blocked on") && m.includes("needs a product decision on X")));
    assert.equal(released, true);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "backlog");
    assert.equal(fresh!.attempts, 0);
  });

  it("reporting done with no PR (isolated workspace) backs off without transitioning, and comments only on the first attempt", async () => {
    const { project, ticket } = await setup();
    worktreesImpl.ensureWorkspace = async (projectDir: string) => ({ cwd: projectDir, branch: "custos/x", isolated: true });
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { status: "ready_for_qa", summary: "done", branch: "custos/x", prUrl: null, subtasks: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "in_progress", "still in_progress, not sent to qa");
    assert.equal(fresh!.attempts, 1);
    assert.equal((fresh!.comments ?? []).length, 1, "first attempt gets exactly one 'no PR' comment");
    assert.ok(activity.some((m) => m.includes("done without a PR")));
  });

  it("a clean 'ready_for_qa' outcome with a PR transitions the ticket to qa and records the run result", async () => {
    const { project, agent, ticket } = await setup();
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { status: "ready_for_qa", summary: "Implemented the thing.", branch: null, prUrl: null, subtasks: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 42, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "qa");
    assert.equal(fresh!.attempts, 0);
    assert.ok(activity.some((m) => m.includes("finished") && m.includes("sent it to QA")));
    const freshAgent = await agentStore.getAgent(agent.id);
    assert.equal(freshAgent!.stats.completed, 1);
  });

  it("the 'finished, sent to QA' event carries a first-person slackText and the acting agent for Slack", async () => {
    const { project, agent, ticket } = await setup();
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { status: "ready_for_qa", summary: "Implemented the thing.", branch: null, prUrl: null, subtasks: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 42, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const messages = collectActivityMessages(orch);
    await orch.runEngineer(project.id, ticket.id);
    const finished = messages.find((m) => m.text.includes("finished") && m.text.includes("sent it to QA"));
    assert.ok(finished, "expected the finished-and-sent-to-QA event");
    // Third-person UI text is unaffected -- same string as before ActivityMessage existed.
    assert.equal(finished!.text, `${agent.name} finished "${ticket.title}" and sent it to QA.`);
    // First-person Slack text speaks as the agent, not about it.
    assert.equal(finished!.slackText, `I finished "${ticket.title}" and sent it to QA.`);
    assert.equal(finished!.agent?.role, "engineer");
    assert.equal(finished!.agent?.name, agent.name);
  });

  it("no result reported (ok but no outcome) is treated as a failure and backs off", async () => {
    const { project, ticket } = await setup();
    runAgentImpl = async () => ({ ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    assert.ok(activity.some((m) => m.includes("did not report a result")));
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.attempts, 1);
    assert.equal(fresh!.status, "in_progress");
  });

  it("an 'unavailable' failure does not back off attempts and emits no activity", async () => {
    const { project, ticket } = await setup();
    runAgentImpl = async () => ({ ok: false, unavailable: true, parsed: null, error: null, text: "", costUsd: null, runMs: 0, runId: "r1" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runEngineer(project.id, ticket.id);
    assert.deepEqual(activity, []);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.attempts, 0);
  });
});

describe("escalateStuckTickets", () => {
  async function setupPrincipal(projectId: string) {
    return agentStore.createAgent({ projectId, role: "principal", name: "Principal Eng", fallbackSet: "principal" });
  }

  it("no-ops when no ticket has reached the attempts threshold", async () => {
    const project = await makeProject();
    await setupPrincipal(project.id);
    const engineer = await agentStore.createAgent({ projectId: project.id, role: "engineer", name: "Eng", fallbackSet: "standard" });
    const ticket = await makeTicket(project.id, { status: "in_progress" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: engineer.id });
    for (let i = 0; i < 4; i++) await board.recordAttemptFailure(ticket.id); // below threshold (5)
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.escalateStuckTickets(project.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.assigneeAgentId, engineer.id, "assignee unchanged below threshold");
    assert.deepEqual(activity, []);
  });

  it("reassigns a ticket at the threshold to the principal agent, clears attempts, and comments", async () => {
    const project = await makeProject();
    const principal = await setupPrincipal(project.id);
    const engineer = await agentStore.createAgent({ projectId: project.id, role: "engineer", name: "Eng", fallbackSet: "standard" });
    const ticket = await makeTicket(project.id, { status: "in_progress" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: engineer.id });
    for (let i = 0; i < 5; i++) await board.recordAttemptFailure(ticket.id);
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.escalateStuckTickets(project.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.assigneeAgentId, principal.id);
    assert.equal(fresh!.attempts, 0, "escalation gives the principal a fresh attempt budget");
    assert.equal(fresh!.nextAttemptAt, null);
    assert.equal(fresh!.status, "in_progress", "reassignment alone does not change the column");
    assert.equal((fresh!.comments ?? []).length, 1);
    assert.match(fresh!.comments![0].body, /Escalated to/);
    assert.ok(activity.some((m) => m.includes("Escalated") && m.includes(ticket.title)));
  });

  it("does not re-escalate a ticket already assigned to the principal", async () => {
    const project = await makeProject();
    const principal = await setupPrincipal(project.id);
    const ticket = await makeTicket(project.id, { status: "in_progress" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: principal.id });
    for (let i = 0; i < 6; i++) await board.recordAttemptFailure(ticket.id);
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.escalateStuckTickets(project.id);
    assert.deepEqual(activity, [], "already on the principal -- nowhere further to escalate");
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.assigneeAgentId, principal.id);
    assert.equal(fresh!.attempts, 6, "attempts untouched when no reassignment happens");
  });

  it("self-seeds the principal agent via ensureProjectAgents when the project doesn't have one yet", async () => {
    const project = await makeProject();
    // Deliberately no setupPrincipal() call -- this project has never had
    // any stage call resolveProjectAgent for it, matching a project with
    // every OTHER autonomy toggle off. The stage must not depend on some
    // other stage having incidentally seeded the roster first.
    const engineer = await agentStore.createAgent({ projectId: project.id, role: "engineer", name: "Eng", fallbackSet: "standard" });
    const ticket = await makeTicket(project.id, { status: "in_progress" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: engineer.id });
    for (let i = 0; i < 5; i++) await board.recordAttemptFailure(ticket.id);
    const orch = makeOrchestrator();
    await assert.doesNotReject(orch.escalateStuckTickets(project.id));
    const fresh = await board.getWorkItem(ticket.id);
    const seeded = await agentStore.findRoleAgent(project.id, "principal");
    assert.ok(seeded, "ensureProjectAgents should have seeded a principal agent");
    assert.equal(fresh!.assigneeAgentId, seeded!.id, "and the stuck ticket escalates to it in the same pass");
  });

  it("ignores tickets stuck in other columns (ready, qa) -- only in_progress is eligible", async () => {
    const project = await makeProject();
    await setupPrincipal(project.id);
    const ticket = await makeTicket(project.id, { status: "ready" });
    for (let i = 0; i < 5; i++) await board.recordAttemptFailure(ticket.id);
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.escalateStuckTickets(project.id);
    assert.deepEqual(activity, []);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.assigneeAgentId, null);
  });
});

describe("runQa", () => {
  async function setup() {
    const project = await makeProject();
    const ticket = await makeTicket(project.id, { status: "qa", prUrl: "https://github.com/x/y/pull/1" });
    return { project, ticket };
  }

  it("a passing verdict releases the workspace and transitions the ticket to complete", async () => {
    const { project, ticket } = await setup();
    let released = false;
    worktreesImpl.releaseWorkspace = async () => { released = true; };
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { verdict: "pass", summary: "Looks good.", criteriaChecked: [], prComments: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runQa(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "complete");
    assert.equal(released, true);
    assert.ok(activity.some((m) => m.includes("QA passed")));
  });

  it("a failing verdict bounces the ticket to ready and records a QA rejection against the assignee", async () => {
    const { project, ticket } = await setup();
    const agent = await agentStore.createAgent({ projectId: project.id, role: "engineer", name: "Eng", fallbackSet: "default" });
    await board.updateWorkItem(ticket.id, { assigneeAgentId: agent.id });
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { verdict: "fail", summary: "Missing a case.", criteriaChecked: [{ criterion: "handles empty input", result: "fail", evidence: "crashes" }], prComments: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runQa(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "ready");
    assert.ok(activity.some((m) => m.includes("bounced")));
    const freshAgent = await agentStore.getAgent(agent.id);
    assert.equal(freshAgent!.stats.qaRejections, 1);
  });

  it("an 'unavailable' failure is completely silent (no activity, no comment)", async () => {
    const { project, ticket } = await setup();
    runAgentImpl = async () => ({ ok: false, unavailable: true, parsed: null, error: null, text: "", costUsd: null, runMs: 0, runId: "r1" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runQa(project.id, ticket.id);
    assert.deepEqual(activity, []);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal((fresh!.comments ?? []).length, 0);
  });

  it("no verdict reported (ok but no outcome) is treated as a failure and backs off", async () => {
    const { project, ticket } = await setup();
    runAgentImpl = async () => ({ ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runQa(project.id, ticket.id);
    assert.ok(activity.some((m) => m.includes("did not report a verdict") && m.includes("attempt 1")));
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "qa");
    assert.equal(fresh!.attempts, 1);
  });

  it("a passing verdict clears any accumulated attempts", async () => {
    const { project, ticket } = await setup();
    await board.recordAttemptFailure(ticket.id);
    await board.recordAttemptFailure(ticket.id);
    runAgentImpl = async (_runtime: unknown, options: { mcpConfig: string }) => {
      const token = tokenFromMcpConfig(options.mcpConfig);
      const session = pmTools.lookupSession(token) as { outcome: unknown };
      session.outcome = { verdict: "pass", summary: "Looks good.", criteriaChecked: [], prComments: [], followUps: [] };
      return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" };
    };
    const orch = makeOrchestrator();
    await orch.runQa(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.attempts, 0);
  });
});

describe("runDevops", () => {
  it("a ticket with no prUrl backs off without attempting a merge", async () => {
    const project = await makeProject();
    const ticket = await makeTicket(project.id, { status: "complete" });
    let mergeCalled = false;
    worktreesImpl.mergePullRequest = async () => { mergeCalled = true; return { ok: true }; };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runDevops(project.id, ticket.id);
    assert.equal(mergeCalled, false);
    assert.ok(activity.some((m) => m.includes("no prUrl recorded")));
  });

  it("an unmergeable PR is sent back to in_progress for rework, not held in complete", async () => {
    const project = await makeProject();
    const ticket = await makeTicket(project.id, { status: "complete", prUrl: "https://github.com/x/y/pull/1" });
    worktreesImpl.checkPrReadyToMerge = async () => ({ ready: false, kind: "unmergeable", reason: "merge conflict" });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runDevops(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "in_progress");
    assert.ok(activity.some((m) => m.includes("back to in_progress") && m.includes("merge conflict")));
  });

  it("a waiting/pending gate backs off (comment only on first attempt) without moving the ticket", async () => {
    const project = await makeProject();
    const ticket = await makeTicket(project.id, { status: "complete", prUrl: "https://github.com/x/y/pull/1" });
    worktreesImpl.checkPrReadyToMerge = async () => ({ ready: false, kind: "waiting", reason: "waiting on QA approval comment" });
    const orch = makeOrchestrator();
    await orch.runDevops(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.status, "complete");
    assert.equal(fresh!.attempts, 1);
    assert.equal((fresh!.comments ?? []).length, 1, "first attempt gets a 'not merged yet' comment from the system actor");
  });

  it("merging with deployTarget 'none' completes the ticket without any agent dispatch", async () => {
    const project = await makeProject();
    const ticket = await makeTicket(project.id, { status: "complete", prUrl: "https://github.com/x/y/pull/1" });
    let dispatched = false;
    runAgentImpl = async () => { dispatched = true; return {}; };
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runDevops(project.id, ticket.id);
    assert.equal(dispatched, false, "deployTarget=none needs no agent judgement at all");
    const fresh = await board.getWorkItem(ticket.id);
    assert.ok(fresh!.labels.includes("deployed"));
    assert.equal(fresh!.attempts, 0);
    assert.ok(activity.some((m) => m.includes("merged the pull request")));
  });

  it("a real deploy target dispatches an agent and marks the ticket deployed on success", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { deployTarget: "docker-local" });
    const ticket = await makeTicket(project.id, { status: "complete", prUrl: "https://github.com/x/y/pull/1" });
    runAgentImpl = async () => ({
      ok: true, unavailable: false, error: null, text: "", costUsd: null, runMs: 5, runId: "r1",
      parsed: { status: "deployed", summary: "Deployed via compose.", estimatedMonthlyUsd: null, awsRegion: null, blockedReason: null },
    });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runDevops(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.ok(fresh!.labels.includes("deployed"));
    assert.ok(activity.some((m) => m.includes("DevOps deployed")));
  });

  it("an AWS deploy missing awsRegion is rejected and backed off instead of accepted", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { deployTarget: "aws" });
    const ticket = await makeTicket(project.id, { status: "complete", prUrl: "https://github.com/x/y/pull/1" });
    runAgentImpl = async () => ({
      ok: true, unavailable: false, error: null, text: "", costUsd: null, runMs: 5, runId: "r1",
      parsed: { status: "deployed", summary: "Deployed.", estimatedMonthlyUsd: null, awsRegion: "", blockedReason: null },
    });
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    await orch.runDevops(project.id, ticket.id);
    const fresh = await board.getWorkItem(ticket.id);
    assert.equal(fresh!.labels.includes("deployed"), false);
    assert.equal(fresh!.attempts, 1);
    assert.ok(activity.some((m) => m.includes("missing awsRegion")));
  });
});

describe("tickProject gating (via tick())", () => {
  // tick() iterates every project in the shared projects.json, not just
  // the one this test created -- earlier describe blocks' projects (with
  // their own Slack channels, backlogs, etc.) are still on disk otherwise
  // and would get ticked right along with this test's fixture, making
  // "no dispatch happened" unverifiable. Every test in this block gets a
  // clean project registry, matching what a real tick() would see if
  // it were the only project configured.
  beforeEach(async () => {
    for (const project of await projectsMod.listProjects()) {
      await projectsMod.deleteProject(project.id);
    }
  });

  it("a paused project is skipped entirely -- no Slack poll, no dispatch", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { paused: true, slackChannelId: "C1" });
    let polled = false;
    slackImpl.fetchNewMessages = async () => { polled = true; return { ok: true, messages: [] }; };
    const orch = makeOrchestrator();
    await orch.tick();
    assert.equal(polled, false);
  });

  it("a project over its monthly budget is skipped and emits one activity line", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { budget: { monthlyUsd: 10, infraMonthlyUsd: null }, pmConfigured: true });
    spendTrackerImpl.getProjectSpend = async () => 10;
    const orch = makeOrchestrator();
    const { activity } = collectEvents(orch);
    let called = false;
    runAgentImpl = async () => { called = true; return {}; };
    await orch.tick();
    assert.equal(called, false);
    assert.ok(activity.some((m) => m.includes("budget") && m.includes("spent")));
  });

  it("first tick with no pmConfigured runs assignModels and nothing else", async () => {
    const project = await makeProject();
    await makeTicket(project.id, { status: "backlog" }); // would otherwise trigger groom
    let tag: string | undefined;
    runAgentImpl = async (_runtime: unknown, options: { tag: string }) => {
      tag = options.tag;
      return { ok: false, unavailable: true, parsed: null, error: null, text: "", costUsd: null, runMs: 0, runId: "r1" };
    };
    const orch = makeOrchestrator();
    await orch.tick();
    await waitUntilIdle(orch);
    assert.equal(tag, "custos-assign-models");
  });

  it("groom is skipped on a second tick when the backlog fingerprint hasn't changed", async () => {
    const project = await makeProject();
    await settingsMod.updateSettings(project.id, { pmConfigured: true });
    await makeTicket(project.id, { status: "backlog" });
    let calls = 0;
    runAgentImpl = async () => { calls++; return { ok: true, unavailable: false, parsed: null, error: null, text: "", costUsd: null, runMs: 5, runId: "r1" }; };
    const orch = makeOrchestrator();
    await orch.tick();
    await waitUntilIdle(orch);
    assert.equal(calls, 1, "first tick grooms the untouched backlog");
    await orch.tick();
    await waitUntilIdle(orch);
    assert.equal(calls, 1, "second tick sees the same fingerprint and does not re-groom");
  });
});
