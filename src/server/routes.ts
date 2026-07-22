import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { Runtime } from "../runtime.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.js";
import { ProviderUnavailableError } from "../types.js";
import { createPreToolUseHandler, type PreToolUseHookInput } from "../permissions/hook-handler.js";
import { createPostToolUseHandler, type PostToolUseHookInput } from "../permissions/post-tool-use-handler.js";
import { AskTracker } from "../permissions/ask-tracker.js";
import { ingestExchange } from "../memory/ingest.js";
import { searchMemory } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import { createUserPromptSubmitHandler, type UserPromptSubmitInput } from "../memory/hook-handlers.js";
import { reconstructFromAnthropicSSE } from "../memory/stream-reconstruct.js";
import { classifyComplexity, isFreshUserTurn } from "../routing/complexity.js";

export interface RouteDeps {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

function recordSpend(runtime: Runtime, providerName: string, usage: { input_tokens: number; output_tokens: number }): void {
  const instance = runtime.config.openaiCompatibleInstances[providerName];
  if (!instance?.pricing) return; // anthropic and unpriced instances (e.g. Ollama) are never tracked
  void runtime.spendTracker.record(providerName, instance.pricing, usage, instance.budget);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const askTracker = new AskTracker();
  const preToolUseHandler = createPreToolUseHandler(deps.runtime, askTracker);
  const postToolUseHandler = createPostToolUseHandler(askTracker);
  const userPromptSubmitHandler = createUserPromptSubmitHandler(deps.memoryStore, deps.runtime);

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicMessagesRequest;

    let providerResponse;
    try {
      const routing = deps.runtime.config.complexityRouting;
      if (routing.enabled && isFreshUserTurn(body)) {
        const tier = await classifyComplexity(deps.runtime.router, body);
        reply.header("x-custos-complexity-tier", tier);
        providerResponse = await deps.runtime.router.completeWithEntries(routing.tiers[tier], body, undefined, `complexity tier "${tier}"`);
      } else {
        providerResponse = await deps.runtime.router.complete("general", body);
      }
    } catch (err) {
      const message = err instanceof ProviderUnavailableError ? err.message : "internal gateway error";
      reply.code(err instanceof ProviderUnavailableError ? 503 : 500);
      return { type: "error", error: { type: "overloaded_error", message } };
    }

    reply.code(providerResponse.status);
    reply.header("x-custos-provider", providerResponse.providerName);
    // content-length no longer matches once the body's been re-streamed
    // through us, and content-encoding/transfer-encoding describe the
    // *upstream* wire format -- fetch() already transparently decompresses
    // the body per the Fetch spec (decompression happens before `res.body`
    // is even exposed), so by the time we forward it it's plain bytes.
    // Copying "content-encoding: gzip" through anyway told downstream
    // clients (the Claude Code CLI's own fetch) to gunzip data that wasn't
    // compressed anymore, which surfaced as a ZlibError there.
    const HOP_BY_HOP_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding"]);
    providerResponse.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) reply.header(key, value);
    });

    if (!providerResponse.body) {
      return reply.send();
    }

    if (body.stream) {
      if (providerResponse.status === 200) {
        const [clientStream, ingestStream] = providerResponse.body.tee();
        reconstructFromAnthropicSSE(ingestStream, body.model)
          .then((reconstructed) => {
            void ingestExchange(body, reconstructed);
            recordSpend(deps.runtime, providerResponse.providerName, reconstructed.usage);
          })
          .catch((err) => req.log.error({ err }, "failed to ingest streamed exchange"));
        return reply.send(Readable.fromWeb(clientStream as never));
      }
      return reply.send(Readable.fromWeb(providerResponse.body as never));
    }

    const text = await new Response(providerResponse.body).text();
    if (providerResponse.status === 200) {
      try {
        const parsed = JSON.parse(text) as AnthropicMessagesResponse;
        void ingestExchange(body, parsed);
        recordSpend(deps.runtime, providerResponse.providerName, parsed.usage);
      } catch {
        // Non-JSON success body (shouldn't happen); skip ingestion.
      }
    }
    reply.header("content-type", "application/json");
    return reply.send(text);
  });

  app.post("/hooks/pretooluse", async (req) => {
    return preToolUseHandler(req.body as PreToolUseHookInput);
  });

  app.post("/hooks/posttooluse", async (req) => {
    return postToolUseHandler(req.body as PostToolUseHookInput);
  });

  app.post("/hooks/user-prompt-submit", async (req) => {
    return userPromptSubmitHandler(req.body as UserPromptSubmitInput);
  });

  app.post("/memory/search", async (req) => {
    const { query, limit } = req.body as { query: string; limit?: number };
    return { results: await searchMemory(deps.memoryStore, deps.runtime.embedding, query, limit) };
  });
}
