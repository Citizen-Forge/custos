import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ADMIN_ASSETS_DIR = process.env.GATEWAY_ADMIN_ASSETS_DIR ?? resolve(process.cwd(), "public", "admin");

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Serves admin.html's ES module source files (public/admin/*.js) at
 * /admin/<path>. admin.html itself is still served separately by
 * config-routes.ts's plain `GET /admin` (a single readFile, not a
 * directory) -- this only handles the `/admin/<something>` shape a
 * `<script type="module" src="/admin/main.js">` (and its own nested
 * imports) actually requests. Mirrors ui-routes.ts's containment
 * pattern (used for the separate /app React build) rather than
 * reintroducing it differently: normalize, strip leading `..` segments,
 * and refuse anything that resolves outside ADMIN_ASSETS_DIR.
 *
 * Registered as a plain wildcard alongside the many explicit
 * `/admin/api/*` routes elsewhere -- Fastify's router matches the most
 * specific registered path regardless of registration order, so this
 * never intercepts an API call; it only serves paths nothing more
 * specific claimed. No-cache (unlike /app's fingerprinted assets):
 * these filenames are stable, so a stale cached copy after a deploy
 * would otherwise persist until a hard refresh.
 */
export function registerAdminAssetsRoutes(app: FastifyInstance): void {
  app.get("/admin/*", async (req, reply) => {
    const relative = (req.params as { "*": string })["*"] ?? "";
    if (!relative.endsWith(".js")) return reply.code(404).send({ error: "not found" });

    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, "");
    const full = join(ADMIN_ASSETS_DIR, safe);
    if (!full.startsWith(ADMIN_ASSETS_DIR + sep) && full !== ADMIN_ASSETS_DIR) {
      return reply.code(403).send({ error: "forbidden" });
    }

    return sendAsset(full, reply);
  });
}

async function sendAsset(full: string, reply: FastifyReply): Promise<unknown> {
  try {
    const body = await readFile(full);
    reply.header("content-type", CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream");
    reply.header("cache-control", "no-cache");
    return reply.send(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "not found" });
    throw err;
  }
}
