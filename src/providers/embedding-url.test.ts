// URL-resolution logic for embeddings. Locks in three things the
// runtime and the admin probe both rely on:
//   1. The Ollama-shape heuristic — baseUrl pointing at port 11430-
//      11440 OR containing "ollama" in the hostname → strip trailing
//      /v1 so the consumer POSTs to Ollama's native /api/embeddings.
//      Any other baseUrl → leave as-is (the consumer posts whatever
//      OpenAI-compat /embeddings the provider happens to expose).
//   2. The override priority chain — agent.embeddingBaseUrl wins over
//      provider.embeddingUrl wins over the URL-shape heuristic. Both
//      overrides strip a trailing /api/embeddings or /embeddings so
//      the consumer can re-append without double-pathing.
//   3. `looksLikeOllamaEndpoint` returns true for the renamed-ollama
//      case (providerKey "local" pointing at host:11434/v1 is the
//      exact case that surfaced as a 404 in the lightspeed project —
//      the bug that motivated this whole commit). Catches any future
//      refactor that returns to providerKey-based detection.
//
// The system-reminder flow (always validate via typecheck + tests
// after non-trivial changes; spawn a reviewer in parallel) drove the
// decision to lift this test file out of the runtime/refreshEmbedding
// layer and into its own suite — the URL derivation is its own
// concern with its own edge cases (renamed providers, services
// bolted onto the same port range, fully qualified hostnames).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeOllamaEndpoint, resolveEmbeddingHost, planEmbeddingProbe } from "./embedding-url.js";

describe("looksLikeOllamaEndpoint", () => {
  it("identifies localhost:11434 as Ollama-shape (the default install)", () => {
    assert.equal(looksLikeOllamaEndpoint("http://localhost:11434/v1"), true);
  });

  it("identifies a remote IP on the Ollama default port as Ollama-shape (the lightspeed-project bug)", () => {
    assert.equal(looksLikeOllamaEndpoint("http://192.168.250.219:11434/v1"), true);
  });

  it("identifies a host whose name contains 'ollama' regardless of port (Docker aliases, service meshes)", () => {
    assert.equal(looksLikeOllamaEndpoint("http://ollama-box.local:8080/v1"), true);
    assert.equal(looksLikeOllamaEndpoint("http://my-ollama.tailnet.ts.net/v1"), true);
  });

  it("accepts the narrow 11430-11440 port range used by Ollama-flavored variants (llama.cpp on 11435, etc.)", () => {
    assert.equal(looksLikeOllamaEndpoint("http://localhost:11435"), true);
    assert.equal(looksLikeOllamaEndpoint("http://localhost:11440"), true);
    assert.equal(looksLikeOllamaEndpoint("http://localhost:11429"), false);
    assert.equal(looksLikeOllamaEndpoint("http://localhost:11441"), false);
  });

  it("rejects OpenAI-compat hosts on common ports", () => {
    assert.equal(looksLikeOllamaEndpoint("https://api.openai.com/v1"), false);
    assert.equal(looksLikeOllamaEndpoint("https://api.deepseek.com/v1"), false);
    assert.equal(looksLikeOllamaEndpoint("https://openrouter.ai/api/v1"), false);
  });

  it("rejects unparseable URLs that don't match the substring heuristic", () => {
    assert.equal(looksLikeOllamaEndpoint("not a url"), false);
    assert.equal(looksLikeOllamaEndpoint(""), false);
  });

  it("falls back to substring matching when URL parsing fails (defensive against typos the user might paste in)", () => {
    assert.equal(looksLikeOllamaEndpoint("http://ollama:11434"), true);
    assert.equal(looksLikeOllamaEndpoint("ollama.example.com"), true);
  });
});

describe("resolveEmbeddingHost — priority chain", () => {
  it("uses the agent-level embeddingBaseUrl when set, overriding everything else", () => {
    const result = resolveEmbeddingHost({
      agentOverride: "http://custom-embeddings.internal/v1/embed",
      providerEmbeddingUrl: "http://provider-override:9999",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(result, "http://custom-embeddings.internal/v1/embed");
  });

  it("strips a trailing /api/embeddings from the agent override so the consumer can re-append canonically", () => {
    const result = resolveEmbeddingHost({
      agentOverride: "http://h:11434/api/embeddings",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(result, "http://h:11434",
      "the consumer always appends /api/embeddings; the override should be a clean host");
  });

  it("strips a trailing /embeddings from the agent override (OpenAI-compat providers that pass a full URL)", () => {
    const result = resolveEmbeddingHost({
      agentOverride: "https://api.openai.com/v1/embeddings",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(result, "https://api.openai.com/v1");
  });

  it("uses the provider-level embeddingUrl when the agent override is unset", () => {
    const result = resolveEmbeddingHost({
      providerEmbeddingUrl: "http://provider-override:9999",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(result, "http://provider-override:9999");
  });

  it("falls back to the URL-shape heuristic when no override is set (the lightspeed-project case)", () => {
    // Provider with providerKey "local" pointing at 192.168.250.219:11434/v1 --
    // no override, hostname doesn't contain "ollama", but the port 11434
    // nails it as Ollama-shape. The chat path's /v1 prefix gets stripped
    // so the consumer can POST to Ollama's native /api/embeddings.
    const result = resolveEmbeddingHost({
      providerBaseUrl: "http://192.168.250.219:11434/v1",
    });
    assert.equal(result, "http://192.168.250.219:11434");
  });

  it("returns the OpenAI-compat base unchanged when no override and not Ollama-shape", () => {
    const result = resolveEmbeddingHost({
      providerBaseUrl: "https://api.openai.com/v1",
    });
    assert.equal(result, "https://api.openai.com/v1");
  });

  it("trims trailing slashes from the heuristic result so a config'd URL with a stray '/' doesn't double-path", () => {
    assert.equal(
      resolveEmbeddingHost({ providerBaseUrl: "http://localhost:11434/v1/" }),
      "http://localhost:11434",
    );
    assert.equal(
      resolveEmbeddingHost({ providerBaseUrl: "https://api.openai.com/v1/" }),
      "https://api.openai.com/v1",
    );
  });

  it("respects stripTrailingEmbeddingPath=false (test surface for the helper's flag)", () => {
    // Set when the caller has already stripped /api/embeddings themselves
    // and wants to preserve the full URL the override supplies as-is.
    const result = resolveEmbeddingHost({
      agentOverride: "http://h:11434/api/embeddings",
      providerBaseUrl: "http://localhost:11434/v1",
      stripTrailingEmbeddingPath: false,
    });
    assert.equal(result, "http://h:11434/api/embeddings");
  });
});

describe("planEmbeddingProbe — admin-side probe plan", () => {
  it("reports the agent-override reason and the Ollama-shape candidate path when the override points at /api/embeddings", () => {
    const plan = planEmbeddingProbe({
      agentOverride: "http://h:11434/api/embeddings",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(plan.reason, "agent-override");
    assert.equal(plan.host, "http://h:11434");
    assert.deepEqual(plan.candidates, [{ path: "/api/embeddings", shape: "ollama" }]);
  });

  it("reports openai-shape candidates for non-Ollama providers (the user-facing UI label matches)", () => {
    const plan = planEmbeddingProbe({
      providerBaseUrl: "https://api.openai.com/v1",
    });
    assert.equal(plan.reason, "openai-shape");
    assert.equal(plan.host, "https://api.openai.com/v1");
    assert.deepEqual(plan.candidates, [{ path: "/embeddings", shape: "openai-compat" }]);
  });

  it("distinguishes Ollama-shape reason so the Admin UI can label the probe 'Ollama POST' vs 'OpenAI POST'", () => {
    const plan = planEmbeddingProbe({
      providerBaseUrl: "http://192.168.250.219:11434/v1",
    });
    assert.equal(plan.reason, "ollama-shape");
    assert.equal(plan.host, "http://192.168.250.219:11434");
    assert.deepEqual(plan.candidates, [{ path: "/api/embeddings", shape: "ollama" }]);
  });

  it("reports provider-override when the named provider sets embeddingUrl directly", () => {
    const plan = planEmbeddingProbe({
      providerEmbeddingUrl: "https://my-cohere-embed-proxy.example/embed",
      providerBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(plan.reason, "provider-override");
    assert.equal(plan.host, "https://my-cohere-embed-proxy.example/embed");
  });
});
