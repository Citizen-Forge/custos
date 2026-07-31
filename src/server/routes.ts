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
import type { FallbackTarget, QueueContext } from "../providers/global-queue.js";
import type { GatewayConfig } from "../config.js";
import type { RemoteSessionManager } from "../remote/session-manager.js";

/** Builds the dispatch chain for the legacy `general` task's priority list.
 *  Every branch of `/v1/messages` flows through the GlobalQueue now, so the
 *  priority list is reshaped into a `FallbackTarget[]` rather than being
 *  handed to the old ProviderRouter. Anthropic entries inherit the body's
 *  own model since AnthropicProvider reads modelOverride → request.model;
 *  OpenAI-compat entries need an explicit model from the provider's
 *  configured default (the first enabled model, falling back to the first
 *  one declared) because modelOverride drives the upstream request's model
 *  field for those providers. The chain order matches `config.tasks.general`
 *  priority order, since that's what the legacy router honored.
 *
 *  Misconfigured entries (legacy `openaiCompatibleInstances` shape, a
 *  typo, an empty `models: []`) are skipped silently — the alternative
 *  is to dispatch with `model: "unknown"` and surface the upstream's
 *  400/404 to the operator, which reads as a runtime bug. Returning an
 *  empty chain is the caller's signal that there's nothing dispatchable;
 *  `routes.ts` translates that into a ProviderUnavailableError so the
 *  request surfaces a coherent error instead of parking forever in the
 *  queue's enqueue path. */
function generalChain(body: AnthropicMessagesRequest, config: GatewayConfig): FallbackTarget[] {
  const out: FallbackTarget[] = [];
  for (const entry of config.tasks.general) {
    if (entry.provider === "anthropic") {
      out.push({ provider: "anthropic", model: body.model });
      continue;
    }
    const providerDef = config.providers?.[entry.provider];
    const def = providerDef?.models.find((m) => m.enabled) ?? providerDef?.models[0];
    if (!def) continue;  // provider isn't properly configured for chat — skip rather than dispatch with model "unknown"
    out.push({ provider: entry.provider, model: def.name });
  }
  return out;
}

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

    // Wire the client's own disconnect into the outgoing dispatch so an
    // abandoned request doesn't leak an in-flight upstream fetch (and the
    // ProviderStateMap slot it's holding) indefinitely. Without this,
    // nothing here ever learns the `claude` CLI subprocess gave up --
    // reply.raw's "close" event fires on ANY connection teardown
    // (including a normal, successful completion), so it's guarded on
    // writableEnded to only abort the genuinely abandoned case.
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    const options: CompleteOptions = { clientBetaHeader, signal: abortController.signal };

    // Every branch below dispatches via the GlobalQueue. Three chain
    // shapes feed it:
    //   - pinned: single-entry chain carrying the explicit (provider, model)
    //   - fallback: chain from the named fallback set's provider list
    //   - general (no alias): chain derived from `config.tasks.general`'s
    //                          priority order, with anthropic entries
    //                          inheriting body.model (see generalChain's
    //                          docstring).
    // The queue handles the rest: availability checks per-provider
    // (cooldown / breaker / capacity / RPM via ProviderStateMap),
    // per-request failover within the chain when the dispatched entry
    // throws ProviderUnavailableError, and queueing when no chain
    // entry can accept a request right now. The legacy ProviderRouter
    // path is no longer reachable from /v1/messages -- it's still wired
    // into the runtime, since complete() callers outside /v1/messages
    // depend on it (memory curator, permission classifier, etc).
    const queue = deps.runtime.globalQueue;
    if (!queue) throw new Error("GlobalQueue not initialized");

    let chain: FallbackTarget[];
    let dispatchContext: QueueContext | undefined;
    if (alias?.type === "pinned") {
      // A PM agent pins its own provider/model via `custos:<provider>/<model>`
      // (see providers/model-alias.ts) -- the alias is unwrapped so the
      // upstream only sees the real model name. The single-entry chain
      // bypasses failover (one provider, no fallthrough) but still goes
      // through the queue so the dispatch event lands in the activity
      // log and the provider's concurrency / RPM limits are honored.
      reply.header("x-custos-pinned", `${alias.providerKey}/${alias.model}`);
      chain = [{ provider: alias.providerKey, model: alias.model }];
      body.model = alias.model;
      dispatchContext = { route: "pinned" };
    } else if (alias?.type === "fallback") {
      // The agent is configured with a fallback set (named list of
      // provider+model pairs). Route through the GlobalQueue so each
      // request in this claude subprocess gets per-request failover:
      // if provider A 429s, the GlobalQueue tries provider B from the
      // same set before surfacing the error. The model sent to the
      // upstream is the one from whichever entry matches -- the queue
      // passes it as modelOverride in CompleteOptions.
      reply.header("x-custos-fallback", alias.fallbackSet);
      const set = deps.runtime.config.fallbackSets?.[alias.fallbackSet];
      if (!set || !set.providers.length) {
        throw new ProviderUnavailableError(`Fallback set "${alias.fallbackSet}" is not configured or is empty`);
      }
      chain = set.providers.map((p) => ({ provider: p.provider, model: p.model }));
      // Set a sensible default model for the body before routing.
      // The GlobalQueue will override this via modelOverride if it
      // dispatches to a different provider, but the body field needs
      // a real value for the ingestion pipeline and for providers
      // that don't support modelOverride. Inlined here so the routes
      // handler owns its own dispatch shape end-to-end and doesn't
      // reach back into Runtime for a chain-construction detail it
      // already computed.
      body.model = set.providers[0]?.model ?? "unknown";
      // Lift caller context (project, agent) from the alias suffix
      // so dispatch events land in the activity log attributed to
      // the right project/agent row. The fallback set name itself
      // is also carried so events without caller context still
      // identify which chain was routed through. The `route` field
      // lets the activity panel discriminate fallback traffic from
      // pinned/general even when the alias context is empty.
      dispatchContext = alias.context
        ? { ...alias.context, fallbackSet: alias.fallbackSet, route: "fallback" }
        : { fallbackSet: alias.fallbackSet, route: "fallback" };
    } else {
      // No alias: build the dispatch chain from `config.tasks.general`'s
      // priority list. Anthropic entries inherit body.model; OpenAI-compat
      // entries get a configured default model (generalChain's docstring).
      // Empty chains (a misconfigured priority list) surface as a
      // ProviderUnavailableError rather than parking the request in the
      // queue's enqueue path waiting for an exit that never comes.
      reply.header("x-custos-general", "true");
      chain = generalChain(body, deps.runtime.config);
      if (chain.length === 0) {
        throw new ProviderUnavailableError("general: no providers in config.tasks.general had a usable default model");
      }
      dispatchContext = { route: "general" };
    }

    let providerResponse;
    try {
      providerResponse = await queue.complete(chain, body, options, dispatchContext);
    } catch (err) {
      const message = err instanceof ProviderUnavailableError ? err.message : "internal gateway error";
      reply.code(err instanceof ProviderUnavailableError ? 503 : 500);
      // Without this, a 503 carried no Retry-After at all -- the caller
      // (the Anthropic SDK inside the `claude` CLI subprocess, which
      // does honor Retry-After on 5xx) had nothing to back off against
      // and either hammered immediately on its own short retry budget
      // or surfaced the 503 as a fatal turn error. err.retryAfterMs is
      // already in ms (set by the queue's enqueue-timeout / provider
      // dispatch paths); HTTP wants whole seconds, rounded up so we
      // never advertise less wait than was actually intended.
      if (err instanceof ProviderUnavailableError && err.retryAfterMs !== undefined) {
        reply.header("retry-after", String(Math.ceil(err.retryAfterMs / 1000)));
      }
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
