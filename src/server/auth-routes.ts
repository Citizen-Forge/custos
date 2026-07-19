import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPassword, changePassword, sessions, SESSION_COOKIE } from "../auth/admin-session.js";

const isProduction = process.env.NODE_ENV === "production" && process.env.GATEWAY_PUBLIC_URL?.startsWith("https://");

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/login", async (_req, reply) => {
    const html = await readFile(join(process.cwd(), "public", "login.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(html);
  });

  app.post("/login", async (req, reply) => {
    const { password } = req.body as { password?: string };
    if (!password || !(await checkPassword(password))) {
      reply.code(401);
      return { error: "wrong password" };
    }
    const sessionId = sessions.create();
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return { ok: true };
  });

  app.post("/logout", async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/admin/api/change-password", async (req, reply) => {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) {
      reply.code(400);
      return { error: "currentPassword and newPassword are required" };
    }
    if (newPassword.length < 8) {
      reply.code(400);
      return { error: "new password must be at least 8 characters" };
    }
    const ok = await changePassword(currentPassword, newPassword);
    if (!ok) {
      reply.code(401);
      return { error: "current password is wrong" };
    }
    return { ok: true };
  });
}
