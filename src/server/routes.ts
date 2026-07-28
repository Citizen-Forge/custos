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
import { parseModelAlias } from "../providers/model-alias.js";
import type { CompleteOptions } from "../providers/types.js";
import type { RemoteSessionManager } from "../remote/session-manager.js";

export interface RouteDeps {
  runtime: Runtime;
  memoryStore: MemoryStore;
  remoteSessionManager: RemoteSessionManager;
}

// How long a chat-mode "ask" waits for a human to click approve/deny before
// failing closed. Kept below the PreToolUse hook's own timeout (see
// headless-settings.ts) so we always return an explicit deny rather than
// letting Claude Code's hook timeout decide.
const APPROVAL_TIMEOUT_MS = 270_000;

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const askTracker = new AskTracker();
  const preToolUseHandler = createPreToolUseHandler(deps.runtime, askTracker);
  const postToolUseHandler = createPostToolUseHandler(askTracker);
  const userPromptSubmitHandler = createUserPromptSubmitHandler(deps.memoryStore, deps.runtime);

  app.get("/health", async () => {
    const { getCommitHash } = await import("../version.js");
    return { ok: true, commit: await getCommitHash() };
  });

  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicMessagesRequest;

    // Forward the client's own anthropic-beta header so beta-gated body
    // fields it sends (e.g. context_management from a recent Claude Code)
    // stay permitted -- Custos otherwise substitutes only its own OAuth
    // beta flags and Anthropic 400s on the now-"extra" input.
    const rawBeta = req.headers["anthropic-beta"];
    const clientBetaHeader = Array.isArray(rawBeta) ? rawBeta.join(",") : rawBeta;

    // Parse the model alias. Two forms:
    //   custos:<provider>/<model>    — pinned to one specific provider
    //   custos:fallback/<set-name>    — routes through the GlobalQueue for
    //                                   per-request failover across the
    //                                   fallback set's providers (if Gemini
    //                                   429s on request #50 in a 500-request
    //                                   run, request #51 falls through to
    //                                   Ollama instead of failing).
    // (see providers/model-alias.ts for the parser).
    const alias = parseModelAlias(body.model);
    const options: CompleteOptions = { clientBetaHeader };
    if (alias?.type === "pinned") {
      body.model = alias.model;
      options.modelOverride = alias.model;
    }

    let providerResponse;
    try {
      if (alias?.type === "pinned") {
        // A PM agent pins its own provider/model via `custos:<provider>/<model>`
        // (see providers/model-alias.ts) -- that choice wins over the general
        // task ordering. The alias is unwrapped so the upstream only sees the
        // real model name.
        reply.header("x-custos-pinned", `${alias.providerKey}/${alias.model}`);
        providerResponse = await deps.runtime.router.completeWithEntries(
          [{ provider: alias.providerKey, priority: 1 }],
          body,
          options,
          `pinned provider "${alias.providerKey}"`,
        );
      } else if (alias?.type === "fallback") {
        // The agent is configured with a fallback set (named list of
        // provider+model pairs). Route through the GlobalQueue so each
        // request in this claude subprocess gets per-request failover:
        // if provider A 429s, the GlobalQueue tries provider B from the
        // same set before surfacing the error. The model sent to the
        // upstream is the one from whichever entry matches -- the queue
        // passes it as modelOverride in CompleteOptions.
        reply.header("x-custos-fallback", alias.fallbackSet);
        // Set a sensible default model for the body before routing.
        // The GlobalQueue will override this via modelOverride if it
        // dispatches to a different provider, but the body field needs
        // a real value for the ingestion pipeline and for providers
        // that don't support modelOverride.
        body.model = deps.runtime.fallbackDefaultModel(alias.fallbackSet);
        providerResponse = await deps.runtime.completeWithFallback(
          alias.fallbackSet,
          body,
          options,
        );
      } else {
        // No alias: use the `general` task's configured priority list
        // (from `config.tasks.general`).
        providerResponse = await deps.runtime.router.complete("general", body, options);
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

  // Used by one-shot `claude -p` turns spawned for chat-mode chats (see
  // remote/turn-runner.ts). There's no TTY in `-p` mode for Claude Code's
  // own interactive permission prompt, so an "ask" is surfaced to the
  // chat's connected clients (the desktop app / browser transcript) as an
  // approval request instead, and this hook blocks until the human answers.
  // Falls back to deny if the chat can't be located or no one is watching
  // -- fail closed, but only after actually offering the choice.
  app.post("/hooks/pretooluse-headless", async (req) => {
    const input = req.body as PreToolUseHookInput;
    const result = await preToolUseHandler(input);
    const verdict = result.hookSpecificOutput.permissionDecision;
    const reason = result.hookSpecificOutput.permissionDecisionReason;
    // "allow" runs automatically. Both "ask" and "deny" are surfaced to the
    // operator, who is the final authority in remote control -- "deny" shown
    // as an override-a-block, "ask" as a routine approval.
    if (verdict === "allow") return result;

    const session = deps.remoteSessionManager.findByClaudeSessionId(input.session_id);
    const respond = (decision: "allow" | "deny", r: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: decision, permissionDecisionReason: r },
    });

    if (!session) {
      return respond("deny", `${reason} (auto-denied: chat session not found to ask in)`);
    }

    const decision = await deps.remoteSessionManager.requestApproval(
      session,
      { toolName: input.tool_name, toolInput: input.tool_input, reason, severity: verdict },
      APPROVAL_TIMEOUT_MS,
    );
    return decision === "allow" ? respond("allow", `approved in chat: ${reason}`) : respond("deny", `denied in chat: ${reason}`);
  });

  // Used by autonomous PM agent runs (product owner, engineer, QA, devops).
  // Nobody is attached to those, so there is no one to ask: an "ask" verdict
  // proceeds and only a hard "deny" blocks. That widening is the whole
  // reason autonomy is opt-in per project and per role in project settings
  // -- it is not the posture any human-attached chat runs under.
  app.post("/hooks/pretooluse-agent", async (req) => {
    const result = await preToolUseHandler(req.body as PreToolUseHookInput);
    const { permissionDecision, permissionDecisionReason } = result.hookSpecificOutput;
    if (permissionDecision !== "ask") return result;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason: `${permissionDecisionReason} (allowed: autonomous agent run, no operator attached to ask)`,
      },
    };
  });

  app.post("/hooks/posttooluse", async (req) => {
    return postToolUseHandler(req.body as PostToolUseHookInput);
  });

  app.post("/hooks/user-prompt-submit", async (req) => {
    return userPromptSubmitHandler(req.body as UserPromptSubmitInput);
  });

  app.post("/memory/search", async (req) => {
    const { query, limit } = req.body as { query: string; limit?: number };
    // No embeddings global agent configured: return an empty result set
    // rather than 500-ing. Memory search is a soft hint -- the surrounding
    // chat still works without it; a hard fail would block the UI from
    // showing the rest of the conversation history.
    if (!deps.runtime.embedding) return { results: [] };
    return { results: await searchMemory(deps.memoryStore, deps.runtime.embedding, query, limit) };
  });
}
