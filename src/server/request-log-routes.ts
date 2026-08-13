import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestLogEntry } from "../providers/request-log.js";

const LOG_DIR = process.env.GATEWAY_REQUEST_LOG_DIR ?? "data/request-log";

async function readDay(date: string): Promise<RequestLogEntry[]> {
  try {
    const raw = await readFile(join(LOG_DIR, `${date}.jsonl`), "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RequestLogEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function recentDates(n: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    dates.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return dates;
}

/** Admin-only read access to request-log.ts's exact-wire-bytes capture
 *  (see that file's header comment for what it's for). Two endpoints:
 *  a lightweight listing (metadata only -- request/response bodies can
 *  be tens of KB each, not something to ship on every list poll) and a
 *  single-entry fetch by id for the full request/response pair a
 *  reproduction script would need. */
export function registerRequestLogRoutes(app: FastifyInstance): void {
  app.get("/admin/api/request-log", async (req) => {
    const { date, projectId, agentId, provider, limit } = req.query as {
      date?: string;
      projectId?: string;
      agentId?: string;
      provider?: string;
      limit?: string;
    };
    const days = date ? [date] : recentDates(3);
    let entries: RequestLogEntry[] = [];
    for (const d of days) entries = entries.concat(await readDay(d));
    if (projectId) entries = entries.filter((e) => e.context.projectId === projectId);
    if (agentId) entries = entries.filter((e) => e.context.agentId === agentId);
    if (provider) entries = entries.filter((e) => e.provider === provider);
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const capped = entries.slice(0, Math.min(Number(limit) || 100, 500));
    // Metadata only -- request/response omitted so the list stays cheap
    // to fetch and render; use the single-entry endpoint for the body.
    return {
      entries: capped.map(({ request: _request, response: _response, ...meta }) => meta),
      daysSearched: days,
    };
  });

  app.get("/admin/api/request-log/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };
    const days = date ? [date] : recentDates(7);
    for (const d of days) {
      const entries = await readDay(d);
      const found = entries.find((e) => e.id === id);
      if (found) return { entry: found };
    }
    reply.code(404);
    return { error: `no request-log entry "${id}" found in the last ${days.length} day(s) -- pass ?date=YYYY-MM-DD if it's older` };
  });
}
