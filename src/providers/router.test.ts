// Pin ProviderRouter's per-instance priority resolution so the admin UI's
// new Priority field lands cleanly across the dispatch path.
//
// The full precedence chain (caller > instance > task default) is resolved
// per-entry inside completeWithEntries: pre-stamping merged.priority in
// complete() would lose the "did the caller actually set it?" signal,
// and the instance-level override wouldn't get a chance to win. These
// tests pin that contract from end to end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter } from "./router.js";
import type { CompleteOptions, Priority, Provider, ProviderResponse } from "./types.js";
import type { AnthropicMessagesRequest, TaskKind } from "../types.js";
import type { GatewayConfig, ProviderEntry } from "../config.js";
import type { SpendTracker } from "./spend-tracker.js";

const ZERO_REQ = {} as AnthropicMessagesRequest;
const OK_RESPONSE: ProviderResponse = { status: 200, headers: new Headers(), body: null };

/** Fake provider that records the priority it sees in `options.priority`
 * at each `complete()` invocation. The recorded order corresponds to
 * invocation order, not submission order, mirroring how the throttle tests
 * distinguish the two. */
function makePriorityRecordingProvider(name: string): { provider: Provider; invocations: string[] } {
  const invocations: string[] = [];
  const provider: Provider = {
    name,
    complete: (_req, options) => {
      invocations.push(options?.priority ?? "<unset>");
      return Promise.resolve(OK_RESPONSE);
    },
  };
  return { provider, invocations };
}

/** Minimal SpendTracker stub -- the router only ever calls
 * `isWithinBudget(name, budget)` on it. Returning true unconditionally
 * keeps the budget branch out of these tests' way. */
function makeAlwaysWithinBudget(): SpendTracker {
  return {
    isWithinBudget: async () => true,
  } as unknown as SpendTracker;
}

/** Build a router with one named instance whose config can vary per test.
 * The provider wiring is rebuilt from `providers[name]` so each test gets
 * a fresh invocation list. */
function buildRouter(
  instanceConfig: { priority?: Priority },
  providers: Record<string, Provider>,
  tasks: Partial<Record<TaskKind, ProviderEntry[]>>,
): { router: ProviderRouter; providers: Record<string, { provider: Provider; invocations: string[] }> } {
  const config: GatewayConfig = {
    openaiCompatibleInstances: {
      // The instance under test -- its priority is what we're exercising.
      inst: { baseUrl: "http://x", model: "m", ...instanceConfig },
    },
    embeddingProvider: { baseUrl: "http://x", model: "emb" },
    tasks: {
      general: [{ provider: "inst", priority: 1 }],
      permissionClassifier: [{ provider: "inst", priority: 1 }],
      memoryCurator: [{ provider: "inst", priority: 1 }],
      complexityClassifier: [{ provider: "inst", priority: 1 }],
      ...tasks,
    },
  };
  const recorded = Object.fromEntries(
    Object.keys(providers).map((k) => [k, { provider: providers[k], invocations: (providers[k] as unknown as { invocations: string[] }).invocations ?? [] }]),
  );
  const router = new ProviderRouter(providers, config, makeAlwaysWithinBudget());
  return { router, providers: recorded };
}

describe("ProviderRouter priority resolution", () => {
  it("task default applies when neither caller nor instance set priority", async () => {
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    // `general` task defaults to "interactive" in priorityForTask.
    await router.complete("general", ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "general task default is interactive");
  });

  it("memoryCurator task default is background when neither caller nor instance override", async () => {
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    await router.complete("memoryCurator", ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "memoryCurator task default is background");
  });

  it("instance priority overrides the task default", async () => {
    // Tag the instance as background, send a `general` request through
    // it -- task default says interactive, instance pins background, so
    // background wins. Same shape for memoryCurator would NOT flip the
    // answer (both sides say background); the converse (instance says
    // interactive, task says background) is what flips it -- tested next.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    await router.complete("general", ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "instance pinned background overrode task default interactive");
  });

  it("instance priority can flip a background-default task to interactive", async () => {
    // memoryCurator defaults to background. If the admin pinned the
    // instance as interactive, the dispatch should reflect the instance
    // config, not the task kind -- otherwise the per-instance UI control
    // would be inert for memoryCurator traffic.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "interactive" }, { inst: provider }, {});
    await router.complete("memoryCurator", ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "instance pinned interactive overrode memoryCurator's background default");
  });

  it("caller-supplied priority wins over both instance and task default", async () => {
    // Caller passes "background" explicitly. Instance is pinned
    // interactive, task is general (interactive). Caller should win.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "interactive" }, { inst: provider }, {});
    const callerOptions: CompleteOptions = { priority: "background" };
    await router.complete("general", ZERO_REQ, callerOptions);
    assert.deepEqual(invocations, ["background"], "caller priority wins over instance and task default");
  });

  it("caller-supplied priority wins over instance when both set, with memoryCurator task", async () => {
    // memoryCurator task default is background. Instance pinned
    // background. Caller passes interactive. Interactive wins.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    const callerOptions: CompleteOptions = { priority: "interactive" };
    await router.complete("memoryCurator", ZERO_REQ, callerOptions);
    assert.deepEqual(invocations, ["interactive"], "caller priority wins over instance priority and task default");
  });

  it("completeWithEntries (no task in scope) falls back to interactive when nothing else is set", async () => {
    // Complexity-tier routing calls completeWithEntries directly without
    // a task kind. The fallback (no caller, no instance, no task) must
    // be "interactive" so the historical behaviour for direct callers
    // holds.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({}, { inst: provider }, {});
    const entries: ProviderEntry[] = [{ provider: "inst", priority: 1 }];
    await router.completeWithEntries(entries, ZERO_REQ);
    assert.deepEqual(invocations, ["interactive"], "completeWithEntries without a task falls back to interactive");
  });

  it("completeWithEntries honours instance priority when no task is in scope", async () => {
    // The per-instance override should apply whether or not a task kind
    // is in scope -- the task kind only contributes the *fallback*
    // value, not the lookup itself.
    const { provider, invocations } = makePriorityRecordingProvider("inst");
    const { router } = buildRouter({ priority: "background" }, { inst: provider }, {});
    const entries: ProviderEntry[] = [{ provider: "inst", priority: 1 }];
    await router.completeWithEntries(entries, ZERO_REQ);
    assert.deepEqual(invocations, ["background"], "instance priority wins over the no-task fallback");
  });

  it("failover: when first instance errors, the per-entry priority resolution re-runs for the fallback", async () => {
    // The router iterates entries and re-resolves priority per-entry
    // (each candidate gets a chance to contribute its own priority
    // before its request is dispatched). The first instance errors
    // (ProviderUnavailableError -> cooldown + continue), the second
    // instance -- with its own priority config -- should be tried with
    // ITS priority, not the first instance's.
    const { provider: a, invocations: aInv } = makePriorityRecordingProvider("a");
    const { provider: b, invocations: bInv } = makePriorityRecordingProvider("b");
    // Override a's complete to throw ProviderUnavailableError once.
    let aCalls = 0;
    a.complete = async () => {
      aCalls += 1;
      aInv.push("would-have-been-sent");
      // Throwing ProviderUnavailableError triggers failover; the
      // cooldown tracker will skip `a` for subsequent calls.
      const { ProviderUnavailableError } = await import("../types.js");
      throw new ProviderUnavailableError("a: HTTP 429");
    };

    const config: GatewayConfig = {
      openaiCompatibleInstances: {
        a: { baseUrl: "http://a", model: "m", priority: "background" },
        b: { baseUrl: "http://b", model: "m", priority: "interactive" },
      },
      embeddingProvider: { baseUrl: "http://x", model: "emb" },
      tasks: {
        general: [{ provider: "a", priority: 1 }, { provider: "b", priority: 2 }],
        permissionClassifier: [],
        memoryCurator: [],
        complexityClassifier: [],
      },
    };
    const router = new ProviderRouter({ a, b }, config, makeAlwaysWithinBudget());
    await router.complete("general", ZERO_REQ);
    assert.equal(aCalls, 1, "first provider was attempted");
    assert.deepEqual(bInv, ["interactive"], "second provider saw its own priority, not the first instance's");
  });
});
