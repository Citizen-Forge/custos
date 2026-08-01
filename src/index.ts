import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import { Agent, setGlobalDispatcher } from "undici";
import { Runtime } from "./runtime.js";
import { registerRoutes } from "./server/routes.js";
import { registerAdminRoutes } from "./server/admin-routes.js";
import { registerRemoteRoutes } from "./server/remote-routes.js";
import { registerProjectRoutes } from "./server/project-routes.js";
import { registerPmRoutes } from "./server/pm-routes.js";
import { registerPmEventRoutes } from "./server/pm-events.js";
import { registerUiRoutes } from "./server/ui-routes.js";
import { Orchestrator } from "./pm/orchestrator.js";
import { failOrphanedRuns } from "./pm/runs.js";
import { registerAuthRoutes } from "./server/auth-routes.js";
import { registerAuthGuard } from "./server/auth-guard.js";
import { ensureAdminPassword } from "./auth/admin-session.js";
import { RemoteSessionManager } from "./remote/session-manager.js";
import { MemoryStore } from "./memory/store.js";
import { startCurator } from "./memory/curator.js";
import { ensureGlobalAgents } from "./pm/global-agents.js";
import { migrateToFallbackSets } from "./pm/agents.js";
import { syncSpawnedSessionCredentials } from "./auth/credentials.js";
import { StatsMonitor, DEFAULT_ALERT_RULES } from "./runtime-stats.js";
import { registerMetricsRoute } from "./server/metrics.js";
import { registerMcpRoutes } from "./server/mcp-routes.js";

const PORT = Number(process.env.PORT ?? 8787);
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const EMBEDDING_VECTOR_SIZE = Number(process.env.EMBEDDING_VECTOR_SIZE ?? 768);
const CURATOR_INTERVAL_MS = Number(process.env.CURATOR_INTERVAL_MS ?? 15 * 60_000);

// Node's global fetch() (used by every provider's dispatch -- openai-compatible.ts,
// anthropic.ts) is built on undici, whose default Agent caps bodyTimeout AND
// headersTimeout at 300_000ms (5 minutes) -- undici/lib/dispatcher/client.js's
// kBodyTimeout default is literally `300e3`. A slow self-hosted model (a local
// Ollama instance with no GPU) generating a long response for one turn can easily
// exceed that, at which point undici tears down the connection mid-stream. That
// doesn't surface as a clean error to the client -- our own reply pipe to the
// spawned `claude` subprocess dies with it (logged by Fastify as "stream closed
// prematurely" / ERR_STREAM_PREMATURE_CLOSE), and the CLI, having received a
// SSE stream that just stops with no terminating event, doesn't reliably notice
// and can sit "running" for the rest of its 45-minute ceiling producing nothing.
// Raising both well past what any real generation should take (RUN_TIMEOUT_MS
// itself is the true backstop at 45 minutes) fixes this at the source rather
// than only bounding the damage after the fact (see agent-runner.ts's
// dead-on-arrival watchdog, which catches the case where this still isn't
// enough). Set once, globally, at startup -- every fetch() in the process
// benefits, not just one call site.
setGlobalDispatcher(new Agent({ bodyTimeout: 20 * 60_000, headersTimeout: 20 * 60_000 }));

async function main() {
  await ensureAdminPassword();

  const runtime = new Runtime();
  // Seed the agents.json collection with one row per built-in global
  // service before runtime.reload() runs — those rows are what
  // Runtime.refreshEmbedding() reads to derive the embedding target,
  // and the curator + classifier handlers read them directly on every
  // invocation. Order matters: existing installs already have a saved
  // embeddingProvider that the background migration prunes; the global
  // agent replaces that, and the runtime picks up the new source here.
  await ensureGlobalAgents();
  await runtime.reload();

  // Repair the bind-mounted ~/:claude/.credentials.json mirror eagerly,
  // BEFORE the orchestrator starts spawning subprocesses. docker-compose
  // mounts `./data/claude-home` -> `/root/.claude` so the mirror file
  // persists across container restarts -- which means any bad shape a
  // previous boot wrote carries forward into the new container. The
  // in-`runTurn` call (every agent spawn) eventually overwrites it, but
  // a freshly-started container with a stale empty mirror would let the
  // first claude subprocess attempt OAuth-refresh against the empty
  // refreshToken and surface the same "OAuth session expired" error we
  // were already shipping a fix for in syncSpawnedSessionCredentials.
  // Doing it once at boot guarantees the file is correct before any
  // subprocess even tries to read it.
  await syncSpawnedSessionCredentials();

  // One-time migration: existing agents created before the fallback-set
  // architecture carry providerKey/model with no fallbackSet. Apply the
  // role-appropriate default fallback set to each, normalize the legacy
  // primary pick to the fallback set's first entry, and reset pmConfigured
  // so the Project Manager re-evaluates on the next tick. Safe to call on
  // every startup — already-migrated agents are skipped. `runtime.config`
  // is the source of truth for which fallback sets exist and what their
  // first entries are; reload() above has already populated it.
  const migrated = await migrateToFallbackSets(runtime.config);
  if (migrated > 0) {
    console.log(`[migrate] Applied fallback-set defaults and primary-pick normalization to ${migrated} agent(s); queued PM re-evaluation.`);
  }

  const memoryStore = new MemoryStore(QDRANT_URL, EMBEDDING_VECTOR_SIZE);

  startCurator(() => ({ runtime, store: memoryStore, embedding: runtime.embedding }), CURATOR_INTERVAL_MS);

  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024, trustProxy: true });

  // Node's http.Server defaults requestTimeout to exactly 300_000ms (5
  // minutes) as of Node 18+ -- a slow-loris mitigation that, per the docs,
  // covers "receiving the entire request from the client" and is meant to
  // be cleared once the request is fully read, not enforced against how
  // long we take to respond. In practice this gateway's own long-lived
  // /v1/messages responses (a request can legitimately spend real time
  // parked in GlobalQueue waiting for a provider slot, then more time
  // again on a slow upstream, all before the first byte goes back) were
  // observed dying at almost exactly 300.0s regardless of every other
  // timeout raised on the client (claude CLI's CLAUDE_STREAM_IDLE_TIMEOUT_MS)
  // and upstream-fetch (undici's bodyTimeout) sides of this same
  // connection -- neither of those changed the cutoff, which is the
  // strongest signal that the constraint was on the SERVER socket itself,
  // not on the client or the outgoing fetch. Disabled outright; Fastify
  // never sets this itself, so it was silently inheriting Node's default.
  app.server.requestTimeout = 0;
  app.server.headersTimeout = 0;

  // Several admin actions are POSTs with no body (disconnect OAuth, clear
  // key, stop chat, ...). Fastify's default JSON parser rejects an empty
  // body outright (FST_ERR_CTP_EMPTY_JSON_BODY) when the request still
  // carries `content-type: application/json` -- which browsers/fetch send
  // by default. Treat an empty json body as `{}` so those no-arg endpoints
  // work regardless of whether the caller bothered to omit the header.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body == null) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(websocket);
  // /admin* and /remote* (and the React app at /app*) are gated by an
  // admin-session cookie via auth-guard.ts. The /v1/messages, /hooks/*,
  // and /memory/search surface is no longer auth-gated: those endpoints
  // are reachable only from custos's own spawned subprocesses, so the
  // client-auth-guard.ts stub is a no-op (its file remains only so that
  // any old `registerClientAuthGuard(app, runtime)` line in a stale PR
  // surfaces loud at startup rather than silently dropping protection).
  // The proxy-era shared-secret `clientApiKey` field is dropped on every
  // config read (config.ts:pruneStaleFields) and on write (config.ts:
  // saveConfig) so legacy on-disk entries converge to canonical shape.
  registerAuthGuard(app);
  registerAuthRoutes(app);
  const remoteSessionManager = new RemoteSessionManager(runtime);

  // Anything still marked "running" in the run log belongs to a process
  // this restart killed, so retire it before the orchestrator starts and
  // the UI shows ghosts as live work.
  await failOrphanedRuns();
  const orchestrator = new Orchestrator(runtime);

  remoteSessionManager.onIdeaHandoff = (projectId, ideaId) => void orchestrator.planIdea(projectId, ideaId);
  orchestrator.start();

  registerRoutes(app, { runtime, memoryStore, remoteSessionManager });
  registerAdminRoutes(app, runtime);
  registerRemoteRoutes(app, remoteSessionManager);
  registerProjectRoutes(app, runtime, remoteSessionManager, (projectId) => void orchestrator.surveyProject(projectId));
  registerPmRoutes(app, runtime, orchestrator);
  registerMcpRoutes(app, orchestrator);
  registerPmEventRoutes(app, orchestrator);
  registerUiRoutes(app);
  registerMetricsRoute(app, runtime);

  // Periodic stats monitor: polls Runtime.stats() and emits sustained-
  // threshold alerts. Interval defaults to 30s; tune via
  // STATS_MONITOR_INTERVAL_MS. Snapshot logging is opt-in
  // (STATS_LOG_SNAPSHOT=1) because 30s cadence is noisy without a
  // downstream log scraper. Threshold alerts always fire -- the whole
  // point of this monitor is to surface saturation before it shows up
  // as user-visible latency.
  const statsMonitor = new StatsMonitor(
    () => runtime.stats(),
    {
      intervalMs: Number(process.env.STATS_MONITOR_INTERVAL_MS ?? 30_000),
      rules: DEFAULT_ALERT_RULES,
      logSnapshot: process.env.STATS_LOG_SNAPSHOT === "1",
    },
  );
  statsMonitor.start();
  // Tie monitor lifecycle to Fastify's shutdown so SIGTERM/SIGINT (and
  // app.close()) clears the timer instead of leaving a dangling
  // interval that keeps the event loop busy.
  // Synchronous body: clearInterval / statsMonitor.stop are sync,
  // so the onClose handler doesn't need to be async — keeping it
  // sync avoids misleading Fastify callers about async cleanup
  // ordering on shutdown.
  app.addHook("onClose", () => {
    statsMonitor.stop();
    runtime.stopMirrorRefresh();
  });

  // Periodic OAuth-mirror re-write (defense in depth on top of the
  // boot-time sync above and the per-spawn sync in turn-runner.ts).
  // The spawned claude CLI on auth-rotation / rate-limit responses can
  // clobber /root/.claude/.credentials.json back to empty within seconds
  // -- a brief window where the next claude -p would inherit the bad
  // shape. The 30s timer caps that window so even a stuck third writer
  // can't keep the mirror bad past one interval. Disabled by setting
  // MIRROR_REFRESH_INTERVAL_MS=0 or any value < 1000ms.
  runtime.startMirrorRefresh();

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("claude-gateway failed to start:", err);
  process.exit(1);
});
