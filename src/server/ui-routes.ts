import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const UI_DIR = process.env.GATEWAY_UI_DIR ?? resolve(process.cwd(), "ui-dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serves the project UI at /app -- the same React application the desktop
 * client runs, built for the browser.
 *
 * It works in a plain browser for one structural reason: it's served from
 * Custos's own origin, so the session cookie set by /login is sent on every
 * request and WebSocket upgrade automatically. The desktop client has to
 * route its networking through Electron's main process precisely because
 * its renderer is a different site; here that problem doesn't exist.
 *
 * /app is under the auth guard's protected paths, so an unauthenticated
 * page load redirects to /login rather than serving a shell that would
 * immediately 401 on every call it made.
 */
export function registerUiRoutes(app: FastifyInstance): void {
  const sendAsset = async (relativePath: string, reply: FastifyReply): Promise<unknown> => {
    // Contain the path inside UI_DIR: everything after /app/ is attacker-
    // controlled, and `..` segments would otherwise read arbitrary files.
    const safe = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const full = join(UI_DIR, safe);
    if (!full.startsWith(UI_DIR + sep) && full !== UI_DIR) {
      return reply.code(403).send({ error: "forbidden" });
    }

    try {
      const body = await readFile(full);
      reply.header("content-type", CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream");
      // Vite fingerprints asset filenames, so they're safe to cache hard;
      // index.html must never be, or a deploy leaves clients on stale code.
      reply.header("cache-control", safe.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return reply.send(body);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  const sendIndex = async (reply: FastifyReply): Promise<unknown> => {
    const sent = await sendAsset("index.html", reply);
    if (sent !== null) return sent;
    reply.code(503).header("content-type", "text/html; charset=utf-8");
    return reply.send(
      "<h1>Web UI not built</h1><p>Run <code>npm run build</code> in <code>ui/</code>, or rebuild the container image.</p>",
    );
  };

  app.get("/app", async (_req, reply) => sendIndex(reply));

  app.get("/app/*", async (req, reply) => {
    const relative = (req.params as { "*": string })["*"] ?? "";
    if (!relative) return sendIndex(reply);
    const sent = await sendAsset(relative, reply);
    // Unknown paths fall through to index.html rather than 404ing: the app
    // is a single page and may grow client-side routes, and a hard 404 on a
    // refreshed deep link is a worse failure than serving the shell.
    return sent === null ? sendIndex(reply) : sent;
  });
}
