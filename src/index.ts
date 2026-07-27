import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
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
import { markProviderAvailable, markProviderUnavailable } from "./pm/model-registry.js";
import { registerAuthRoutes } from "./server/auth-routes.js";
import { registerAuthGuard } from "./server/auth-guard.js";
import { registerClientAuthGuard } from "./server/client-auth-guard.js";
import { ensureAdminPassword } from "./auth/admin-session.js";
import { RemoteSessionManager } from "./remote/session-manager.js";
import { MemoryStore } from "./memory/store.js";
import { startCurator } from "./memory/curator.js";
import { StatsMonitor, DEFAULT_ALERT_RULES } from "./runtime-stats.js";

const PORT = Number(process.env.PORT ?? 8787);
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const EMBEDDING_VECTOR_SIZE = Number(process.env.EMBEDDING_VECTOR_SIZE ?? 768);
const CURATOR_INTERVAL_MS = Number(process.env.CURATOR_INTERVAL_MS ?? 15 * 60_000);

async function main() {
  await ensureAdminPassword();

  const runtime = new Runtime();
  await runtime.reload();

  const memoryStore = new MemoryStore(QDRANT_URL, EMBEDDING_VECTOR_SIZE);

  startCurator(() => ({ router: runtime.router, store: memoryStore, embedding: runtime.embedding }), CURATOR_INTERVAL_MS);

  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024, trustProxy: true });

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
  registerAuthGuard(app);
  registerClientAuthGuard(app, runtime);
  registerAuthRoutes(app);
  const remoteSessionManager = new RemoteSessionManager(runtime);

  // Anything still marked "running" in the run log belongs to a process
  // this restart killed, so retire it before the orchestrator starts and
  // the UI shows ghosts as live work.
  await failOrphanedRuns();
  const orchestrator = new Orchestrator(runtime);

  // Provider availability is learned from the providers themselves -- a 429
  // carries its own reset time -- rather than inferred from failed agent
  // runs. This is what lets the engineering manager know a subscription
  // window is exhausted and route around it instead of stalling the board.
  runtime.setAvailabilityListener({
    onUnavailable(providerName, retryAfterMs, reason) {
      void markProviderUnavailable(providerName, retryAfterMs, reason);
    },
    onAvailable(providerName) {
      void markProviderAvailable(providerName);
    },
  });
  // A handoff out of Steering Co is the one moment where waiting a full
  // poll interval is visibly wrong -- the user just pressed the button.
  remoteSessionManager.onIdeaHandoff = (projectId, ideaId) => void orchestrator.planIdea(projectId, ideaId);
  orchestrator.start();

  registerRoutes(app, { runtime, memoryStore, remoteSessionManager });
  registerAdminRoutes(app, runtime);
  registerRemoteRoutes(app, remoteSessionManager);
  registerProjectRoutes(app, runtime, remoteSessionManager, (projectId) => void orchestrator.surveyProject(projectId));
  registerPmRoutes(app, runtime, orchestrator);
  registerPmEventRoutes(app, orchestrator);
  registerUiRoutes(app);

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
  app.addHook("onClose", async () => {
    statsMonitor.stop();
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("claude-gateway failed to start:", err);
  process.exit(1);
});
