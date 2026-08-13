import type { FastifyInstance } from "fastify";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../../types.js";
import { ProviderUnavailableError } from "../../types.js";
import { ingestExchange } from "../../memory/ingest.js";
import { reconstructFromAnthropicSSE } from "../../memory/stream-reconstruct.js";
import { parseModelAlias } from "../../providers/model-alias.js";
import type { CompleteOptions } from "../../providers/types.js";
import type { FallbackTarget, QueueContext } from "../../providers/global-queue.js";
import type { RouteDeps } from "./types.js";
import { generalChain } from "./messages-route/chain.js";
import { writeSseError, pipeWebStreamToRaw } from "./messages-route/sse.js";

/** The /v1/messages dispatch handler: alias parsing, dispatch-chain
 * construction, and streaming/non-streaming response handling. The two
 * pure helpers this used to define inline -- generalChain (dispatch-chain
 * construction for the legacy `general` task) and the SSE
 * write/pipe helpers -- now live under ./messages-route/. The handler
 * itself stays as one function: it's a single Fastify route, and its
 * streaming vs. buffered branches share the request's abort signal,
 * dispatch chain, and context through one linear lifecycle that splitting
 * across files would only obscure, not simplify. */
export function registerMessagesRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicMessagesRequest;

    // Forward the client's own anthropic-beta header so beta-gated body
    // fields it sends (e.g. context_management from a recent Claude Code)
    // stay permitted -- Custos otherwise substitutes only its own OAuth
    // beta flags and Anthropic 400s on the now-"extra" input.
    const rawBeta = req.headers["anthropic-beta"];
    const clientBetaHeader = Array.isArray(rawBeta) ? rawBeta.join(",") : rawBeta;

    // Forward the spawned `claude` CLI's own first-party-identity headers
    // to the real Anthropic API. Confirmed live (captured a genuine CLI
    // request with a debug echo server) that Claude Code sends a full
    // fingerprint here -- User-Agent, x-app: cli, x-claude-code-session-id,
    // and the whole x-stainless-* family -- none of which previously made
    // it past this gateway; anthropic.ts built its outgoing request from
    // scratch with only content-type/anthropic-version/auth. An OAuth
    // token from a subscription login is meant to be used by Anthropic's
    // own client, and every request this gateway relayed was, from
    // Anthropic's side, indistinguishable from a bare unbranded HTTP
    // client holding a token it shouldn't have programmatic access with --
    // a much likelier explanation for the header-less, generic-message
    // 429s observed live than anything about request volume or timing.
    const CLIENT_IDENTITY_HEADER_NAMES = [
      "user-agent", "x-app", "x-claude-code-session-id",
      "x-stainless-arch", "x-stainless-lang", "x-stainless-os",
      "x-stainless-package-version", "x-stainless-retry-count",
      "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
      "anthropic-dangerous-direct-browser-access",
    ];
    const clientIdentityHeaders: Record<string, string> = {};
    for (const name of CLIENT_IDENTITY_HEADER_NAMES) {
      const value = req.headers[name];
      if (typeof value === "string") clientIdentityHeaders[name] = value;
    }

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
    const options: CompleteOptions = { clientBetaHeader, clientIdentityHeaders, signal: abortController.signal };

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

    // Streaming requests (every real agent turn) commit to the response
    // immediately, before queue.complete() is even called, and keep the
    // connection alive with periodic pings while it works. Without this,
    // the client (the Anthropic SDK inside the spawned `claude` CLI
    // subprocess) receives zero bytes -- not even a status line -- for
    // however long dispatch takes. Queueing behind a saturated provider,
    // then falling through a chain where every entry is rate-limited, can
    // legitimately take minutes; the CLI's own client-side "waiting for a
    // response" timeout (observed at ~300s, distinct from
    // CLAUDE_STREAM_IDLE_TIMEOUT_MS, which only bounds idle time *after*
    // a response has started) was giving up and tearing down the
    // connection long before a slow-but-working fallback chain ever got a
    // chance to succeed -- the exact "This operation was aborted" failures
    // seen in the activity log despite the 40-minute enqueue budget and
    // 45-minute run ceiling never having been reached.
    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...(reply.getHeaders() as Record<string, string>),
      });
      // writeHead() alone only schedules the status line -- Node's
      // http.ServerResponse doesn't actually put it on the wire until the
      // first write()/end() call, which would otherwise be our first ping
      // up to PING_INTERVAL_MS later. flushHeaders() forces it out now,
      // which is the entire point of committing early.
      reply.raw.flushHeaders();
      const pingTimer = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write('event: ping\ndata: {"type": "ping"}\n\n');
      }, 15_000);

      let providerResponse;
      try {
        providerResponse = await queue.complete(chain, body, options, dispatchContext);
      } catch (err) {
        clearInterval(pingTimer);
        const message = err instanceof ProviderUnavailableError ? err.message : "internal gateway error";
        writeSseError(reply.raw, message);
        reply.raw.end();
        return;
      }
      clearInterval(pingTimer);

      if (!providerResponse.body) {
        reply.raw.end();
        return;
      }
      if (providerResponse.status !== 200) {
        // Headers already committed to 200 -- relay the upstream's
        // failure as an SSE error event instead of a status code. The
        // CLI's SSE parser already handles this event type since it's
        // part of the real Anthropic streaming protocol.
        const errText = await new Response(providerResponse.body).text();
        writeSseError(reply.raw, errText);
        reply.raw.end();
        return;
      }
      const [clientStream, ingestStream] = providerResponse.body.tee();
      reconstructFromAnthropicSSE(ingestStream, body.model)
        .then((reconstructed) => {
          void ingestExchange(body, reconstructed);
        })
        .catch((err) => req.log.error({ err }, "failed to ingest streamed exchange"));
      await pipeWebStreamToRaw(clientStream, reply.raw);
      return;
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
}
