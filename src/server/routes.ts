import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { ProviderRouter } from "../providers/router.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.js";
import { ProviderUnavailableError } from "../types.js";
import { createPreToolUseHandler, type PreToolUseHookInput } from "../permissions/hook-handler.js";
import { createPostToolUseHandler, type PostToolUseHookInput } from "../permissions/post-tool-use-handler.js";
import { AskTracker } from "../permissions/ask-tracker.js";
import { ingestExchange } from "../memory/ingest.js";
import { searchMemory } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingConfig } from "../memory/embeddings.js";
import { createUserPromptSubmitHandler, type UserPromptSubmitInput } from "../memory/hook-handlers.js";
import { reconstructFromAnthropicSSE } from "../memory/stream-reconstruct.js";

export interface RouteDeps {
  router: ProviderRouter;
  memoryStore: MemoryStore;
  embedding: EmbeddingConfig;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const askTracker = new AskTracker();
  const preToolUseHandler = createPreToolUseHandler(deps.router, askTracker);
  const postToolUseHandler = createPostToolUseHandler(askTracker);
  const userPromptSubmitHandler = createUserPromptSubmitHandler(deps.memoryStore, deps.embedding);

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicMessagesRequest;

    let providerResponse;
    try {
      providerResponse = await deps.router.complete("general", body);
    } catch (err) {
      const message = err instanceof ProviderUnavailableError ? err.message : "internal gateway error";
      reply.code(err instanceof ProviderUnavailableError ? 503 : 500);
      return { type: "error", error: { type: "overloaded_error", message } };
    }

    reply.code(providerResponse.status);
    providerResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-length") reply.header(key, value);
    });

    if (!providerResponse.body) {
      return reply.send();
    }

    if (body.stream) {
      if (providerResponse.status === 200) {
        const [clientStream, ingestStream] = providerResponse.body.tee();
        reconstructFromAnthropicSSE(ingestStream, body.model)
          .then((reconstructed) => ingestExchange(body, reconstructed))
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
    return { results: await searchMemory(deps.memoryStore, deps.embedding, query, limit) };
  });
}
