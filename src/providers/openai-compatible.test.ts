// Integration smoke for OpenAICompatibleProvider's failure-path glue:
// `provider.complete()` must surface the upstream's Retry-After into
// `ProviderUnavailableError.retryAfterMs` so the router's
// `CooldownTracker` waits the upstream-requested duration instead of
// silently falling back to 60s default (the bug behind "still not
// getting any successful completions" against Gemini Free).
//
// The full RFC 7231 parsing contract (numeric-seconds, HTTP-date,
// past-date clamp, missing/unparseable) is pinned at the parser
// level in `retry-header.test.ts`. This file pins only the *thin
// glue*: that OpenAICompatibleProvider asks the parser and threads
// the result into ProviderUnavailableError's constructor. If a
// future refactor drops the parse call or swaps it for a stale
// inline implementation, this test catches the regression at the
// provider boundary rather than letting it surface only at retry
// time on Unraid.
//
// Fetch stubbing strategy: each test wraps its body in a try/finally
// helper (`withStubbedFetch`) that saves the original `globalThis.fetch`
// synchronously, swaps in a canned Response, and restores in `finally`
// AFTER the test body's await settles. This is synchronous and
// guaranteed-clean even if the test throws synchronously — a stricter
// pattern than the earlier `queueMicrotask`-deferred restore that
// could leak state to subsequent tests in the same describe block if
// a previous test's microtask hadn't run yet.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderUnavailableError } from "../types.js";

/** Build a real-shape AnthropicMessagesRequest with one empty user
 * message so `toOpenAIRequest` doesn't choke on a missing messages
 * array (openai-translate iterates request.messages). */
const VALID_REQ = {
  model: "gemini-2.0-flash-lite",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
} as unknown as Parameters<OpenAICompatibleProvider["complete"]>[0];

/** Run `body()` against a stubbed globalThis.fetch that returns the
 * canned Response, restoring the original fetch in `finally`
 * regardless of whether the body threw or resolved. The restore is
 * synchronous (no microtask scheduling), so a sibling test starting
 * right after this one sees the real fetch. */
async function withStubbedFetch<T>(
  response: { status: number; headers: Record<string, string>; body?: string },
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(response.body ?? "", {
      status: response.status,
      headers: response.headers,
    })) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe("OpenAICompatibleProvider: Retry-After surfaces to ProviderUnavailableError", () => {
  it("threads Retry-After seconds into retryAfterMs on a 429", async () => {
    await withStubbedFetch({ status: 429, headers: { "retry-after": "30" } }, async () => {
      const provider = new OpenAICompatibleProvider("gemini-free", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.0-flash-lite",
      });
      await assert.rejects(
        () => provider.complete(VALID_REQ),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError,
            `expected ProviderUnavailableError, got ${(err as Error).name}`);
          assert.equal((err as ProviderUnavailableError).retryAfterMs, 30_000);
          assert.match((err as Error).message, /HTTP 429/);
          return true;
        },
      );
    });
  });

  it("threads Retry-After on a 503 (Gemini Free quota-exhausted path)", async () => {
    await withStubbedFetch({ status: 503, headers: { "retry-after": "120" } }, async () => {
      const provider = new OpenAICompatibleProvider("gemini-free", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.0-flash-lite",
      });
      await assert.rejects(
        () => provider.complete(VALID_REQ),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal((err as ProviderUnavailableError).retryAfterMs, 120_000);
          return true;
        },
      );
    });
  });

  it("leaves retryAfterMs undefined when no Retry-After header is present", async () => {
    await withStubbedFetch({ status: 429, headers: {} }, async () => {
      const provider = new OpenAICompatibleProvider("gemini-free", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.0-flash-lite",
      });
      await assert.rejects(
        () => provider.complete(VALID_REQ),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal((err as ProviderUnavailableError).retryAfterMs, undefined,
            "missing header must NOT fabricate a value; router default applies");
          return true;
        },
      );
    });
  });

  it("a 413 whose body describes a TPM/RPM limit is treated as ProviderUnavailableError (Groq quirk)", async () => {
    // Regression: Groq reports its tokens-per-minute rate limit via HTTP
    // 413 ("Request too large ... on tokens per minute (TPM): Limit
    // 12000, Requested ...") instead of 429. Before this fix the 413
    // branch only logged a diagnostic and fell through to `return` the
    // raw response -- tryExecute() in global-queue.ts treated that as a
    // completed (if erroring) request, so Groq was never marked cooling
    // and the fallback set never advanced to the next provider. Agents
    // kept retrying the same exhausted Groq model forever.
    const body = JSON.stringify({
      error: {
        message:
          "Request too large for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 105998, please reduce your message size and try again.",
      },
    });
    await withStubbedFetch({ status: 413, headers: {}, body }, async () => {
      const provider = new OpenAICompatibleProvider("groq", {
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
        maxRequestBytes: 33_554_432,
      });
      await assert.rejects(
        () => provider.complete(VALID_REQ),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError,
            `expected ProviderUnavailableError, got ${(err as Error).name}`);
          assert.match((err as Error).message, /rate limited/i);
          return true;
        },
      );
    });
  });

  it("a 413 whose body does NOT describe a rate limit still returns upstream status unchanged", async () => {
    // A genuine payload-too-large rejection (no TPM/RPM/quota wording)
    // must not be swept into the rate-limit path -- it's a real content
    // problem the byte-fit logic already tried to avoid, not a
    // transient upstream exhaustion the fallback set should route
    // around.
    await withStubbedFetch(
      { status: 413, headers: {}, body: "{\"error\":\"payload too large\"}" },
      async () => {
        const provider = new OpenAICompatibleProvider("groq", {
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
          maxRequestBytes: 33_554_432,
        });
        const res = await provider.complete(VALID_REQ);
        assert.equal(res.status, 413);
      },
    );
  });

  it("non-429/5xx responses return upstream status unchanged (not thrown)", async () => {
    // Contract gap guard: a 400 (or any non-429, non-5xx) means a
    // malformed client request, not an upstream-availability
    // signal. The provider returns the upstream's response (with
    // the problematic status) so the caller can decide what to do
    // with it. The router's fail-over path doesn't apply. This pins
    // that the if-branch that returns the upstream status is still
    // reached; if a future refactor accidentally rewrapped the
    // entire `!res.ok` block into `throw ProviderUnavailableError`,
    // this test catches the regression at the provider boundary.
    await withStubbedFetch(
      { status: 400, headers: {}, body: "{\"error\":\"bad request\"}" },
      async () => {
        const provider = new OpenAICompatibleProvider("llm", {
          baseUrl: "https://example.invalid/v1",
          model: "m",
        });
        const res = await provider.complete(VALID_REQ);
        assert.equal(res.status, 400,
          "non-429/5xx paths must return upstream status, not throw");
      },
    );
  });
});
