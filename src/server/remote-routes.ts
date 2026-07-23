import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawData } from "ws";
import { RemoteSessionManager } from "../remote/session-manager.js";

export function registerRemoteRoutes(app: FastifyInstance, manager: RemoteSessionManager): void {
  app.get("/remote", async (_req, reply) => {
    const html = await readFile(join(process.cwd(), "public", "remote.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(html);
  });

  app.get("/remote/ws", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    const session = token ? manager.findByToken(token) : null;
    if (!session) {
      socket.close(4001, "invalid or expired token");
      return;
    }

    session.clients.add(socket);
    socket.send(JSON.stringify({ type: "connected", running: manager.isRunning(session.chatId) }));

    socket.on("message", (raw: RawData) => {
      let msg: { type?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "user_message" && typeof msg.text === "string" && msg.text.trim()) {
        manager.sendUserMessage(session, msg.text).catch((err) => {
          socket.send(JSON.stringify({ type: "error", message: (err as Error).message }));
        });
      }
    });

    socket.on("close", () => {
      session.clients.delete(socket);
    });
  });
}
