import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeUnavailableError, runPreSpawnProbe } from "./probe.js";
import type { Runtime } from "../runtime.js";
import type { AnthropicMessagesRequest } from "../types.js";
import type { ProviderResponse } from "../providers/types.js";

/**
 * Minimal Runtime stub. The Runtime class has many other members but the
 * probe only reads `probeProvider`, so the cast keeps the test focused on
 * the probe's policy without standing up a real ProviderStateMap. The
 * responder callback takes the explicit `providerKey`, `model`, and
 * `request` so each test can introspect any of the three.
 */
function fakeRuntime(
  respond: (providerKey: string, model: string, request: AnthropicMessagesRequest) => Promise<ProviderResponse> | ProviderResponse,
): Runtime {
  const stub = {
    async probeProvider(providerKey: string, model: string, request: AnthropicMessagesRequest) {
      return respond(providerKey, model, request);
    },
  };
  return stub as unknown as Runtime;
}

function response(status: number, text: string): ProviderResponse {
  return {
    status,
    headers: new Headers(),
    body: new Blob([text]).stream(),
  };
}

/** Round-3 regression pin: the probe must forward the TARGETED model to
 *  the underlying provider as `modelOverride`, not the provider's default.
 *  Without this, an agent whose fallback-set entry says
 *  `groq/llama-3.3-70b-versatile` would be probed against the provider's
 *  configured default model (e.g. `llama-3.1-8b-instant`) -- and report
 *  "fine" when in fact the targeted 70B is hitting the 12k TPM cap. The
 *  `fakeRuntime` responder receives the (providerKey, model, request)
 *  triple forwarded by `runtime.probeProvider`, so the assertion proves
 *  the targeted model reached the provider rather than the runtime's
 *  default `this.config.model`. */
test("pre-spawn probe: forwards targeted model via modelOverride (round-3 pin)", async () => {
  const captures: Array<{ providerKey: string; model: string; forwardedModel: string }> = [];
  const runtime = fakeRuntime((providerKey, forwardedModel, _req) => {
    captures.push({ providerKey, model: "llama-3.3-70b-versatile", forwardedModel });
    return response(200, "{\"content\":[{\"text\":\"ok\"}]}");
  });
  await runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile");
  assert.equal(captures.length, 1, "probe must reach the responder exactly once");
  assert.equal(captures[0].model, "llama-3.3-70b-versatile", "requested model is the fallback-set entry");
  assert.equal(captures[0].forwardedModel, "llama-3.3-70b-versatile", "runtime.probeProvider must forward the targeted model to the provider so the upstream hit matches the agent's fallback-set entry, not the provider's constructed default");
});

/** The probe asks for max_tokens=1 with a single "ping" user message so any
 *  TPM-cap'd provider can answer in the smallest possible request. Pin
 *  the request shape so adding fields later doesn't accidentally explode
 *  the per-probe TPM cost. */
test("pre-spawn probe: sends max_tokens=1 with one tiny user message", async () => {
  const captures: AnthropicMessagesRequest[] = [];
  const runtime = fakeRuntime((_k, _m, req) => {
    captures.push(req);
    return response(200, "{\"content\":[{\"text\":\"pong\"}]}");
  });
  await runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile");
  assert.equal(captures.length, 1, "probe must capture the request exactly once");
  assert.equal(captures[0].model, "llama-3.3-70b-versatile");
  assert.equal(captures[0].max_tokens, 1);
  assert.equal(captures[0].messages.length, 1);
  assert.equal(captures[0].messages[0].role, "user");
});

test("pre-spawn probe: 200 OK proceeds without throwing", async () => {
  const runtime = fakeRuntime(() => response(200, "{\"content\":[{\"text\":\"ok\"}]}"));
  await runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile");
  // no throw = pass
});

test("pre-spawn probe: 401 aborts with reason=auth", async () => {
  const runtime = fakeRuntime(() => response(401, "{\"error\":\"invalid api key\"}"));
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "m"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError &&
      err.status === 401 &&
      err.reason === "auth",
  );
});

test("pre-spawn probe: 403 with empty body still aborts (auth drift is unconditional)", async () => {
  const runtime = fakeRuntime(() => response(403, ""));
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "m"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError &&
      err.status === 403 &&
      err.reason === "auth",
  );
});

test("pre-spawn probe: 429 aborts with reason=rate-limited", async () => {
  const runtime = fakeRuntime(() => response(429, "{\"error\":\"rate limit exceeded\"}"));
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "m"),
    (err: unknown) => err instanceof ProbeUnavailableError && err.reason === "rate-limited",
  );
});

/** The actual Groq-on-TPM-cap case observed on Unraid: status=413 with
 *  a "tokens per minute" envelope. The probe must catch this even though
 *  413 isn't a 401/403/429, so the keyword-match path is the load-bearing
 *  one for downstream rate-limits. */
test("pre-spawn probe: 413 with tokens-per-minute body aborts rate-limited (the Groq case)", async () => {
  const runtime = fakeRuntime(() =>
    response(
      413,
      '{"error":{"message":"Request too large for model `llama-3.3-70b-versatile` in organization `org_01kyq33ssnfvcsx6acsr86akac` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested"}}',
    ),
  );
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError &&
      err.reason === "rate-limited" &&
      err.message.includes("groq/llama-3.3-70b-versatile"),
  );
});

test("pre-spawn probe: 4xx with quota keyword aborts rate-limited", async () => {
  const runtime = fakeRuntime(() => response(413, "{\"error\":\"You exceeded your current quota\"}"));
  await assert.rejects(
    runPreSpawnProbe(runtime, "openai", "gpt-4"),
    (err: unknown) => err instanceof ProbeUnavailableError && err.reason === "rate-limited",
  );
});

test("pre-spawn probe: 4xx with model-not-found keyword aborts decommissioned", async () => {
  const runtime = fakeRuntime(() => response(400, "{\"error\":\"model llama-3.3-70b-versatile not found\"}"));
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError && err.reason === "decommissioned",
  );
});

test("pre-spawn probe: 4xx with unrelated body proceeds (model exists)", async () => {
  // A random 4xx ("system prompt required") doesn't match any of our
  // keyword buckets -- the model is alive, the request shape is just
  // slightly off. The real agent run has a system prompt so it'll pass.
  const runtime = fakeRuntime(() => response(400, "{\"error\":\"system prompt required\"}"));
  await runPreSpawnProbe(runtime, "openai", "gpt-4");
  // no throw = pass
});

test("pre-spawn probe: 500 proceeds (transient upstream, real run retries)", async () => {
  const runtime = fakeRuntime(() => response(500, "internal error"));
  await runPreSpawnProbe(runtime, "groq", "llama-3.3-70b-versatile");
  // no throw = pass
});

test("pre-spawn probe: error message includes providerKey/model so the activity feed is searchable", async () => {
  const runtime = fakeRuntime(() => response(413, "RPM quota exceeded"));
  try {
    await runPreSpawnProbe(runtime, "groq", "llama-3.1-8b-instant");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof ProbeUnavailableError);
    assert.equal(err.providerKey, "groq");
    assert.equal(err.model, "llama-3.1-8b-instant");
    assert.match(err.message, /groq\/llama-3.1-8b-instant/);
    // Snippet is the upstream error body collapsed to one line.
    assert.ok(err.snippet.length <= 200);
    assert.match(err.snippet, /RPM.*quota/);
  }
});

/** OAuth-expiry envelopes aren't matched by "invalid api key" or
 *  "401", but they ARE auth failures. Without broadening the auth
 *  bucket to include "OAuth session expired" / "token expired" /
 *  "refresh token failed", an Anthropic OAuth drift would slip past
 *  the probe and trigger the 30-second claude -p storm the probe is
 *  designed to prevent. */
test("pre-spawn probe: 4xx with OAuth session-expired body aborts auth", async () => {
  const runtime = fakeRuntime(() =>
    response(
      400,
      '{"error":{"message":"OAuth session expired and could not be refreshed"}}',
    ),
  );
  await assert.rejects(
    runPreSpawnProbe(runtime, "anthropic", "claude-sonnet-5"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError &&
      err.reason === "auth" &&
      err.message.includes("OAuth"),
  );
});

/** The probe must not block agent spawns indefinitely when an upstream
 *  is slow (Ollama cold-load, Anthropic cold-start). A 5-second ceiling
 *  converts the gate from "probe blocked the agent for 30 s" into
 *  "probe timed out, agent kicks offs immediately", which is strictly
 *  better even if the timeout itself aborts -- the real spawn would
 *  fail anyway. */
test("pre-spawn probe: slow upstream times out with reason=unknown", { timeout: 10_000 }, async () => {
  const runtime = fakeRuntime(
    () =>
      new Promise<ProviderResponse>((resolve) => {
        // Never resolve within the 5s probe ceiling. `.unref()` here
        // ensures the test doesn't keep the runner alive for 30s in
        // the wake of the probe rejection -- once the awaiting test
        // function returns, the unresolved promise is no longer
        // needed and shouldn't pin the loop.
        const t = setTimeout(() => resolve(response(200, "{}")), 30_000);
        t.unref();
      }),
  );
  await assert.rejects(
    runPreSpawnProbe(runtime, "ollama", "llama3.1:8b"),
    (err: unknown) =>
      err instanceof ProbeUnavailableError &&
      err.status === 0 &&
      err.reason === "unknown" &&        err.message.includes("timed out"),
  );
});

test("pre-spawn probe: body stream unreadable doesn't crash the probe", async () => {
  // Some provider implementations lock the body stream after the status
  // is read; the probe MUST still abort on 401/403 even when the body
  // is unreadable, since the status sentinel is the load-bearing signal.
  const runtime = fakeRuntime(() => ({
    status: 401,
    headers: new Headers(),
    // A stream whose getReader().read() throws on first read is what
    // we'd see if the upstream connection was reset before body.
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("stream already consumed"));
      },
    }) as ReadableStream<Uint8Array>,
  }));
  await assert.rejects(
    runPreSpawnProbe(runtime, "groq", "m"),
    (err: unknown) => err instanceof ProbeUnavailableError && err.reason === "auth",
  );
});
