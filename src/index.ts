import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import { Runtime } from "./runtime.js";
import { registerRoutes } from "./server/routes.js";
import { registerAdminRoutes } from "./server/admin-routes.js";
import { registerRemoteRoutes } from "./server/remote-routes.js";
import { registerProjectRoutes } from "./server/project-routes.js";
import { registerAuthRoutes } from "./server/auth-routes.js";
import { registerAuthGuard } from "./server/auth-guard.js";
import { registerClientAuthGuard } from "./server/client-auth-guard.js";
import { ensureAdminPassword } from "./auth/admin-session.js";
import { RemoteSessionManager } from "./remote/session-manager.js";
import { MemoryStore } from "./memory/store.js";
import { startCurator } from "./memory/curator.js";

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
  registerRoutes(app, { runtime, memoryStore, remoteSessionManager });
  registerAdminRoutes(app, runtime);
  registerRemoteRoutes(app, remoteSessionManager);
  registerProjectRoutes(app, runtime, remoteSessionManager);

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("claude-gateway failed to start:", err);
  process.exit(1);
});
