// Tests for the embed() function.
//
// Covers both path shapes (Ollama /api/embeddings vs OpenAI-compat /embeddings),
// error handling on non-ok status, and response parsing.
//
// The global fetch is mocked per-test so the actual network is never hit.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { embed } from "./embeddings.js";
import type { EmbeddingConfig } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type for a fetch mock that records the request it received. */
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replace globalThis.fetch with a mock that records calls and returns a
 *  controllable response. Returns a getter for the recorded calls. */
function mockFetch(response: { ok: boolean; status?: number; embedding?: number[] }): {
  getCalls: () => FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method: init?.method ?? "GET", headers, body });

    return {
      ok: response.ok,
      status: response.status ?? 200,
      json: async () => ({ embedding: response.embedding ?? [0.1, 0.2, 0.3] }),
      headers: new Headers(),
    } as Response;
  };

  return {
    getCalls: () => calls,
    restore: () => { globalThis.fetch = original; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("embed", () => {
  let mock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    // Default mock: success
    mock = mockFetch({ ok: true });
  });

  afterEach(() => {
    mock.restore();
  });

  // ── Path shape: Ollama ──────────────────────────────────────────────

  it("POSTs to {baseUrl}/api/embeddings with {model, prompt} when path=/api/embeddings", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text:latest",
      path: "/api/embeddings",
    };

    await embed(config, "some text to embed");

    const calls = mock.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost:11434/api/embeddings");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.deepEqual(calls[0].body, {
      model: "nomic-embed-text:latest",
      prompt: "some text to embed",
    });
  });

  it("POSTs with {model, prompt} body (Ollama shape) even when path is explicitly set", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "http://192.168.250.219:11434",
      model: "nomic-embed-text:latest",
      path: "/api/embeddings",
    };

    await embed(config, "ollama test text");

    const calls = mock.getCalls();
    assert.deepEqual(calls[0].body, {
      model: "nomic-embed-text:latest",
      prompt: "ollama test text",
    }, "Ollama path uses {model, prompt}, not {model, input}");
  });

  it("documents raw concatenation when baseUrl has a trailing slash (caller normalises baseUrl)", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434/",  // trailing slash — caller's job to strip
      model: "m",
      path: "/api/embeddings",
    };

    await embed(config, "text");
    const calls = mock.getCalls();
    // embed() concatenates baseUrl + path verbatim; the caller
    // (runtime.refreshEmbedding via resolveEmbeddingHost) is responsible
    // for normalising the host. This test documents the behaviour:
    // a // in the URL is the result of NOT stripping the trailing slash.
    assert.equal(calls[0].url, "http://localhost:11434//api/embeddings");
  });

  // ── Path shape: OpenAI-compat ───────────────────────────────────────

  it("POSTs to {baseUrl}/embeddings with {model, input} when path=/embeddings", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      path: "/embeddings",
    };

    await embed(config, "some text");

    const calls = mock.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.deepEqual(calls[0].body, {
      model: "text-embedding-3-small",
      input: "some text",
    }, "OpenAI-compat path uses {model, input}");
  });

  it("POSTs with {model, input} body (OpenAI shape) even for non-standard paths", async () => {
    // An exotic provider that uses a custom path — still treated as
    // non-Ollama (not /api/embeddings) so body is {model, input}.
    const config: EmbeddingConfig = {
      baseUrl: "https://cohere.example",
      model: "embed-english-v3.0",
      path: "/embed",
    };

    await embed(config, "cohere text");

    const calls = mock.getCalls();
    assert.equal(calls[0].url, "https://cohere.example/embed");
    assert.deepEqual(calls[0].body, {
      model: "embed-english-v3.0",
      input: "cohere text",
    }, "Custom path uses {model, input} (the non-Ollama default)");
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("throws an error with HTTP status when the upstream returns non-ok", async () => {
    mock.restore();
    mock = mockFetch({ ok: false, status: 401 });

    const config: EmbeddingConfig = {
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      path: "/embeddings",
    };

    await assert.rejects(
      () => embed(config, "text"),
      /embedding request failed: HTTP 401/,
    );
  });

  it("throws a 500 error when upstream returns 500", async () => {
    mock.restore();
    mock = mockFetch({ ok: false, status: 500 });

    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434",
      model: "m",
      path: "/api/embeddings",
    };

    await assert.rejects(
      () => embed(config, "text"),
      /embedding request failed: HTTP 500/,
    );
  });

  // ── Response parsing ───────────────────────────────────────────────

  it("returns json.embedding from the response body", async () => {
    mock.restore();
    mock = mockFetch({ ok: true, embedding: [0.5, 0.6, 0.7, 0.8] });

    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text:latest",
      path: "/api/embeddings",
    };

    const result = await embed(config, "text");
    assert.deepEqual(result, [0.5, 0.6, 0.7, 0.8]);
  });

  it("returns json.embedding as a non-empty float array (smoke test for the response shape)", async () => {
    mock.restore();
    mock = mockFetch({ ok: true, embedding: [0.1, 0.2, 0.3] });

    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434",
      model: "m",
      path: "/api/embeddings",
    };

    const result = await embed(config, "text");
    assert.ok(Array.isArray(result), "embedding is an array");
    assert.equal(result.length, 3);
    assert.ok(result.every((v) => typeof v === "number"), "all elements are numbers");
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it("handles empty text input (Ollama path)", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "http://localhost:11434",
      model: "m",
      path: "/api/embeddings",
    };

    await embed(config, "");

    const calls = mock.getCalls();
    assert.equal(calls[0].body.prompt, "", "empty prompt forwarded");
  });

  it("handles empty text input (OpenAI-compat path)", async () => {
    const config: EmbeddingConfig = {
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      path: "/embeddings",
    };

    await embed(config, "");

    const calls = mock.getCalls();
    assert.equal(calls[0].body.input, "", "empty input forwarded");
  });
});
