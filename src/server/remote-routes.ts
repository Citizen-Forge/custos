import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawData } from "ws";
import { RemoteSessionManager } from "../remote/session-manager.js";

function publicUrl(): string {
  return process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
}

export function registerRemoteRoutes(app: FastifyInstance): void {
  const manager = new RemoteSessionManager();

  app.post("/admin/api/remote/start", async (_req, reply) => {
    try {
      const session = manager.start();
      return { token: session.token, connectUrl: `${publicUrl()}/remote?token=${session.token}` };
    } catch (err) {
      reply.code(409);
      return { error: (err as Error).message };
    }
  });

  app.post("/admin/api/remote/stop", async () => {
    manager.stop();
    return { ok: true };
  });

  app.get("/admin/api/remote/status", async () => {
    const session = manager.current;
    if (!session) return { active: false };
    return {
      active: true,
      connectUrl: `${publicUrl()}/remote?token=${session.token}`,
      connectedClients: session.clients.size,
      startedAt: session.startedAt,
      cwd: session.cwd,
    };
  });

  app.get("/remote", async (_req, reply) => {
    const html = await readFile(join(process.cwd(), "public", "remote.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(html);
  });

  // Vendored so the page works fully offline / without a CDN dependency.
  app.get("/vendor/xterm.js", async (_req, reply) => {
    const js = await readFile(join(process.cwd(), "node_modules", "@xterm", "xterm", "lib", "xterm.js"), "utf8");
    reply.header("content-type", "application/javascript; charset=utf-8");
    return reply.send(js);
  });
  app.get("/vendor/xterm.css", async (_req, reply) => {
    const css = await readFile(join(process.cwd(), "node_modules", "@xterm", "xterm", "css", "xterm.css"), "utf8");
    reply.header("content-type", "text/css; charset=utf-8");
    return reply.send(css);
  });
  app.get("/vendor/addon-fit.js", async (_req, reply) => {
    const js = await readFile(join(process.cwd(), "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"), "utf8");
    reply.header("content-type", "application/javascript; charset=utf-8");
    return reply.send(js);
  });

  app.get("/remote/ws", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    const session = token ? manager.findByToken(token) : null;
    if (!session) {
      socket.close(4001, "invalid or expired token");
      return;
    }

    session.clients.add(socket);

    const disposable = session.proc.onData((data) => {
      socket.send(JSON.stringify({ type: "output", data }));
    });

    socket.on("message", (raw: RawData) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        session.proc.write(msg.data);
      } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        session.proc.resize(msg.cols, msg.rows);
      }
    });

    socket.on("close", () => {
      session.clients.delete(socket);
      disposable.dispose();
    });
  });
}
