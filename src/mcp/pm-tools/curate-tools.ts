import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { approveFact, rejectFact, FACT_CATEGORIES } from "../../pm/facts.js";
import type { CurateSession } from "./session.js";
import { fail, ok, resolveId } from "./shared.js";

/** Tools for the facts curator: approve a pending proposal into the shared
 *  store (with optional consolidation) or reject it outright. Scoped to
 *  one session's validPendingIds -- a stale or cross-project id is rejected
 *  the same way promote_ticket rejects one outside its backlog. */
export function buildCurateToolsServer(session: CurateSession): McpServer {
  const server = new McpServer({ name: "custos-pm", version: "1.0.0" });

  server.registerTool(
    "approve_fact",
    {
      title: "Approve a pending fact",
      description: "Promotes a pending proposal into the shared knowledge store every agent's prompt is built from. Optionally rewrite its key/value/category first -- e.g. to merge it into an existing stable key, or tighten wording -- without a separate edit step.",
      inputSchema: {
        factId: z.string().describe("The pending fact's id, from the review queue in your prompt."),
        key: z.string().optional().describe("Replacement key, if the proposed one should be merged into a different stable key."),
        value: z.string().optional().describe("Replacement value, if it needs tightening."),
        category: z.enum(FACT_CATEGORIES as [string, ...string[]]).optional().describe("Replacement category, if it's mis-filed."),
      },
    },
    async ({ factId: rawFactId, key, value, category }) => {
      const factId = resolveId(rawFactId, session.validPendingIds);
      if (!factId) return fail(`"${rawFactId}" is not one of the pending facts you were given this run.`);
      const approved = await approveFact(factId, { key, value, category: category as never });
      if (!approved) return fail(`Pending fact "${factId}" no longer exists or was already reviewed.`);
      session.actions.push(`approved "${approved.key}"`);
      return ok(`Approved "${approved.key}".`);
    },
  );

  server.registerTool(
    "reject_fact",
    {
      title: "Reject a pending fact",
      description: "Discards a pending proposal -- use for anything not genuinely durable and useful long-term: a note about one ticket, a duplicate of something already covered, something already stale, or an outright hallucination.",
      inputSchema: {
        factId: z.string().describe("The pending fact's id, from the review queue in your prompt."),
        reason: z.string().optional().describe("One line: why this isn't worth keeping. Not stored -- just for the run's activity log."),
      },
    },
    async ({ factId: rawFactId, reason }) => {
      const factId = resolveId(rawFactId, session.validPendingIds);
      if (!factId) return fail(`"${rawFactId}" is not one of the pending facts you were given this run.`);
      const removed = await rejectFact(factId);
      if (!removed) return fail(`Pending fact "${factId}" no longer exists or was already reviewed.`);
      session.actions.push(`rejected a proposal${reason ? ` (${reason})` : ""}`);
      return ok("Rejected.");
    },
  );

  return server;
}
