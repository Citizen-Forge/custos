import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import { Runtime } from "./runtime.js";
import { registerRoutes } from "./server/routes.js";
import { registerAdminRoutes } from "./server/admin-routes.js";
import { registerRemoteRoutes } from "./server/remote-routes.js";
import { registerAuthRoutes } from "./server/auth-routes.js";
import { registerAuthGuard } from "./server/auth-guard.js";
import { ensureAdminPassword } from "./auth/admin-session.js";
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

  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(websocket);
  registerAuthGuard(app);
  registerAuthRoutes(app);
  registerRoutes(app, { runtime, memoryStore });
  registerAdminRoutes(app, runtime);
  registerRemoteRoutes(app, runtime);

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("claude-gateway failed to start:", err);
  process.exit(1);
});
