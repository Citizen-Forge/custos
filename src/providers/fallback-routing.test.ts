// End-to-end integration test for fallback-set routing.
//
// Exercises the full chain:
//   formatFallbackAlias → parseModelAlias →
//     /v1/messages routes.ts builds FallbackTarget[] inline →
//       GlobalQueue.complete → provider dispatch with failover
//
// Plus ProviderStateMap state verification after a 429, and a Fastify
// inject test that confirms the /v1/messages handler sets x-custos-fallback.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Provider, ProviderResponse, CompleteOptions } from "./types.js";
import { GlobalQueue } from "./global-queue.js";
import { ProviderStateMap } from "./provider-state.js";
import { ProviderUnavailableError, type AnthropicMessagesRequest } from "../types.js";
import { formatFallbackAlias, parseModelAlias, formatModelAlias } from "./model-alias.js";
import { registerRoutes, type RouteDeps } from "../server/routes.js";

const ZERO_REQ = {} as AnthropicMessagesRequest;
const OK_RESPONSE: ProviderResponse = { status: 200, headers: new Headers(), body: null };

// ---------------------------------------------------------------------------
// Helper: a provider whose complete() can be controlled per-call
// ---------------------------------------------------------------------------

type CallSpec = { delayMs?: number; throw?: Error; resolveWith?: ProviderResponse };
function makeControllableProvider(name: string, specs: CallSpec[] = []): {
  provider: Provider;
  /** Override behaviour for the Nth call. The provider reads from specs
   * at invocation time; missing spec = succeed immediately. */
  setSpec: (n: number, spec: CallSpec) => void;
  callCount: () => number;
} {
  const mutableSpecs: CallSpec[] = [...specs];
  let calls = 0;

  const provider: Provider = {
    name,
    complete: (_req, _options) => {
      const idx = calls++;
      const spec = mutableSpecs[idx];
      if (!spec) return Promise.resolve(OK_RESPONSE);
      return new Promise<ProviderResponse>((resolve, reject) => {
        const action = () => {
          if (spec.throw) reject(spec.throw);
          else resolve(spec.resolveWith ?? OK_RESPONSE);
        };
        if (spec.delayMs) setTimeout(action, spec.delayMs);
        else action();
      });
    },
  };

  return {
    provider,
    setSpec: (n: number, spec: CallSpec) => { mutableSpecs[n] = spec; },
    callCount: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Model alias tests
// ---------------------------------------------------------------------------

describe("fallback model alias", () => {
  it("formatFallbackAlias produces correct alias string", () => {
    assert.equal(formatFallbackAlias("complex"), "custos:fallback/complex");
    assert.equal(formatFallbackAlias("standard"), "custos:fallback/standard");
  });

  it("parseModelAlias recognizes custos:fallback/<set-name>", () => {
    const r = parseModelAlias("custos:fallback/complex");
    assert.ok(r !== null);
    assert.equal(r.type, "fallback");
    if (r.type === "fallback") {
      assert.equal(r.fallbackSet, "complex");
    }
  });

  it("parseModelAlias still recognizes custos:<provider>/<model> (backward compat)", () => {
    const r = parseModelAlias("custos:anthropic/claude-sonnet-5");
    assert.ok(r !== null);
    assert.equal(r.type, "pinned");
    if (r.type === "pinned") {
      assert.equal(r.providerKey, "anthropic");
      assert.equal(r.model, "claude-sonnet-5");
    }
  });

  it("parseModelAlias prefers fallback marker over provider named 'fallback'", () => {
    // If someone happened to name a provider "fallback", the old parser would
    // interpret `custos:fallback/something` as provider="fallback", model="something".
    // The new parser treats it as a fallback alias first.
    const r = parseModelAlias("custos:fallback/complex");
    assert.ok(r !== null);
    assert.equal(r.type, "fallback", "fallback marker takes precedence over provider named fallback");
  });

  it("parseModelAlias returns null for empty set name", () => {
    assert.equal(parseModelAlias("custos:fallback/"), null);
  });

  it("formatFallbackAlias + parseModelAlias round-trips", () => {
    const setName = "complex";
    const alias = formatFallbackAlias(setName);
    const parsed = parseModelAlias(alias);
    assert.ok(parsed !== null);
    assert.equal(parsed.type, "fallback");
    if (parsed.type === "fallback") {
      assert.equal(parsed.fallbackSet, setName);
    }
  });
});

// ---------------------------------------------------------------------------
// GlobalQueue — fallback-set dispatch with failover
// ---------------------------------------------------------------------------

describe("GlobalQueue fallback-set dispatch", () => {
  it("dispatches to the first available provider in the fallback set", async () => {
    const state = new ProviderStateMap();
    state.register("gemini");
    state.register("ollama");
    const { provider: gemini, callCount: geminiCalls } = makeControllableProvider("gemini");
    const { provider: ollama } = makeControllableProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const result = await q.complete(
      [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    assert.equal(result.providerName, "gemini", "first available provider was chosen");
    assert.equal(geminiCalls(), 1, "gemini was called once");
  });

  it("fails over to the next provider on ProviderUnavailableError", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama");
    const { provider: gemini } = makeControllableProvider("gemini", [
      { throw: new ProviderUnavailableError("rate limited", 60_000) },
    ]);
    const { provider: ollama, callCount: ollamaCalls } = makeControllableProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    const result = await q.complete(
      [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    assert.equal(result.providerName, "ollama", "failed over to ollama after gemini 429");
    assert.equal(ollamaCalls(), 1, "ollama was called as fallback");

    // ProviderStateMap: gemini should be on cooldown.
    assert.equal(state.canAccept("gemini"), false, "gemini on cooldown after 429");
    assert.ok(state.get("gemini")!.coolingUntil !== null, "gemini coolingUntil set");
  });

  it("throws the last ProviderUnavailableError when all available providers fail", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama", { cooldownFallbackMs: 30_000 });
    const { provider: gemini } = makeControllableProvider("gemini", [
      { throw: new ProviderUnavailableError("gemini 429", 60_000) },
    ]);
    const { provider: ollama } = makeControllableProvider("ollama", [
      { throw: new ProviderUnavailableError("ollama 503", 30_000) },
    ]);
    const q = new GlobalQueue({ gemini, ollama }, state);

    await assert.rejects(
      () => q.complete(
        [{ provider: "gemini", model: "g" }, { provider: "ollama", model: "o" }],
        ZERO_REQ,
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProviderUnavailableError);
        // The last-available-provider's error should be thrown (ollama's).
        assert.ok(err.message.includes("503"), "last provider's error message");
        return true;
      },
    );

    // Both providers on cooldown.
    assert.equal(state.canAccept("gemini"), false, "gemini on cooldown");
    assert.equal(state.canAccept("ollama"), false, "ollama on cooldown");
  });

  it("queues when no provider is available (all at concurrency cap)", async () => {
    const state = new ProviderStateMap();
    state.register("ollama", { maxConcurrent: 1 });
    const release = state.acquire("ollama"); // saturate

    const { provider: ollama } = makeControllableProvider("ollama");
    const q = new GlobalQueue({ ollama }, state);

    const p = q.complete(
      [{ provider: "ollama", model: "qwen2.5:14b" }],
      ZERO_REQ,
    );

    assert.equal(q.queuedTotal, 1, "request queued when provider saturated");

    // Free the slot and pump so the queued request resolves.
    release();
    q.pump();

    const result = await p;
    assert.equal(result.providerName, "ollama", "queued request dispatched after slot freed");
    assert.equal(q.queuedTotal, 0, "queue drained");
  });
});

// ---------------------------------------------------------------------------
// ProviderStateMap state verification after 429
// ---------------------------------------------------------------------------

describe("ProviderStateMap state after 429 in fallback flow", () => {
  it("records cooldown and active=0 after a ProviderUnavailableError", async () => {
    const state = new ProviderStateMap();
    state.register("gemini", { cooldownFallbackMs: 60_000 });
    state.register("ollama");
    const { provider: gemini } = makeControllableProvider("gemini", [
      { throw: new ProviderUnavailableError("rate limited", 60_000) },
    ]);
    const { provider: ollama } = makeControllableProvider("ollama");
    const q = new GlobalQueue({ gemini, ollama }, state);

    await q.complete(
      [{ provider: "gemini", model: "g" }, { provider: "ollama", model: "o" }],
      ZERO_REQ,
    );

    // gemini: should be cooling, breaker marking, active=0
    const g = state.get("gemini")!;
    assert.ok(g.coolingUntil !== null, "cooling set");
    assert.equal(g.active, 0, "slot released after error");
    // active should have been released in the finally block of tryExecute
    assert.equal(g.active, 0, "active=0");
  });

  it("records circuit breaker after 5th consecutive 429", async () => {
    const state = new ProviderStateMap();
    state.register("unstable", { cooldownFallbackMs: 30_000 });

    // Fire 5 recordFailure calls directly into the state map to trip
    // the breaker, then verify the GlobalQueue respects it.
    for (let i = 0; i < 5; i++) state.recordFailure("unstable");

    const u = state.get("unstable")!;
    assert.ok(u.breakerUntil !== null, "breaker tripped after 5 failures");
    assert.equal(state.canAccept("unstable"), false, "circuit-broken provider rejected");

    // Now dispatch through the GlobalQueue — unstable is broken so
    // the request should fail over to backup.
    const { provider: unstable } = makeControllableProvider("unstable");
    const { provider: backup, callCount: backupCalls } = makeControllableProvider("backup");
    state.register("backup");
    const q = new GlobalQueue({ unstable, backup }, state);

    await q.complete(
      [{ provider: "unstable", model: "u" }, { provider: "backup", model: "b" }],
      ZERO_REQ,
    );

    assert.equal(backupCalls(), 1, "backup handled the request because unstable is broken");
  });

  it("success after failure resets breaker state", async () => {
    const state = new ProviderStateMap();
    state.register("wobbly");

    // Trip the breaker with 5 consecutive failures.
    for (let i = 0; i < 5; i++) state.recordFailure("wobbly");
    assert.ok(state.get("wobbly")!.breakerUntil !== null, "breaker tripped");

    // Now a success should clear it.
    state.recordSuccess("wobbly");
    assert.equal(state.get("wobbly")!.breakerUntil, null, "breaker cleared after success");
    assert.equal(state.canAccept("wobbly"), true, "wobbly available again after success");
  });
});

// ---------------------------------------------------------------------------
// HTTP handler test via Fastify inject
// ---------------------------------------------------------------------------

describe("HTTP /v1/messages fallback header", () => {
  it("sets x-custos-fallback header for custos:fallback/ aliases", async () => {
    // This test verifies the Fastify route handler correctly identifies
    // fallback aliases and sets the response header. The actual dispatch
    // is mocked because we don't want real network calls.
    //
    // We create a minimal Runtime whose GlobalQueue resolves a fake
    // response. The route handler calls `runtime.globalQueue.complete(chain, ...)`, which the mock satisfies.
    const mockRuntime = {
      globalQueue: {
        complete: async (_chain: unknown, _req: AnthropicMessagesRequest, _opts?: CompleteOptions) => ({
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          body: new Blob([JSON.stringify({ content: [], model: "test" })]).stream(),
          providerName: "mock-provider",
        }),
      },
      providerState: new ProviderStateMap(),
      spendTracker: {
        record: async () => {},
        projectSpend: () => ({ totalUsd: 0, budgetUsd: null }),
      },
      config: { fallbackSets: { complex: { providers: [{ provider: "gemini", model: "g" }] } } },
    } as any;

    const app = Fastify();
    // Mock auth guard — noop for test.
    app.addHook("onRequest", async (_req, reply) => { /* pass */ });
    registerRoutes(app, {
      runtime: mockRuntime,
      memoryStore: {} as any,
      remoteSessionManager: {} as any,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custos:fallback/complex",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-custos-fallback"], "complex", "x-custos-fallback header set");
    assert.ok(res.headers["x-custos-provider"] !== undefined, "x-custos-provider header set");

    await app.close();
  });

  it("does NOT set x-custos-fallback for pinned custos:<provider>/<model> aliases", async () => {
    const mockRuntime = {
      globalQueue: {
        complete: async () => ({
          status: 200, headers: new Headers(), body: null, providerName: "mock",
        }),
      },
      providerState: new ProviderStateMap(),
      spendTracker: { record: async () => {}, projectSpend: () => ({ totalUsd: 0, budgetUsd: null }) },
      config: {},
    } as any;

    const app = Fastify();
    app.addHook("onRequest", async (_req, reply) => { /* pass */ });
    registerRoutes(app, {
      runtime: mockRuntime,
      memoryStore: {} as any,
      remoteSessionManager: {} as any,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custos:anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-custos-pinned"], "anthropic/claude-sonnet-5", "x-custos-pinned header set");
    assert.equal(res.headers["x-custos-fallback"], undefined, "no x-custos-fallback header for pinned aliases");

    await app.close();
  });
});
