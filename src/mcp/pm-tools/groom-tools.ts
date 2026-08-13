import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as board from "../../pm/board.js";
import type { GroomSession } from "./session.js";
import { fail, ok, registerRecordFact, resolveId } from "./shared.js";

/** Tools for grooming the backlog: promote/revise/comment on tickets, plus
 *  the shared record_fact. Scoped to one session's validTicketIds -- a
 *  ticket id outside the backlog this run was given (stale, mistyped, or
 *  belonging to another project entirely) is rejected rather than acted on. */
export function buildGroomToolsServer(session: GroomSession): McpServer {
  const server = new McpServer({ name: "custos-pm", version: "1.0.0" });

  server.registerTool(
    "promote_ticket",
    {
      title: "Promote a backlog ticket to ready",
      description: "Moves a ticket from backlog to ready -- it will be picked up and worked autonomously. Only use this when the ticket is shaped well enough for an engineer to finish without coming back to ask what you meant.",
      inputSchema: { ticketId: z.string().describe("The work item id, from the backlog list in your prompt.") },
    },
    async ({ ticketId: rawTicketId }) => {
      const ticketId = resolveId(rawTicketId, session.validTicketIds);
      if (!ticketId) return fail(`"${rawTicketId}" is not one of the backlog tickets you were given this run.`);
      if (!board.canTransition("product-owner", "ready")) return fail("Product owner cannot promote tickets to ready in this project's settings.");
      const item = await board.transitionWorkItem(ticketId, "ready", session.agentId, "shaped and ready to work");
      if (!item) return fail(`Ticket "${ticketId}" no longer exists or already moved.`);
      session.actions.push(`promoted "${item.title}" to ready`);
      return ok(`Promoted "${item.title}" to ready.`);
    },
  );

  server.registerTool(
    "revise_ticket",
    {
      title: "Revise a backlog ticket's shape",
      description: "Updates a ticket's title, description, and/or acceptance criteria in place. Use this for a ticket that's nearly ready but needs tightening -- do not promote it in the same turn unless the revision alone makes it ready.",
      inputSchema: {
        ticketId: z.string().describe("The work item id."),
        title: z.string().optional().describe("New title, if it needs one."),
        description: z.string().optional().describe("New description, if it needs one."),
        acceptanceCriteria: z.array(z.string()).optional().describe("Replacement acceptance criteria list, if it needs one."),
      },
    },
    async ({ ticketId: rawTicketId, title, description, acceptanceCriteria }) => {
      const ticketId = resolveId(rawTicketId, session.validTicketIds);
      if (!ticketId) return fail(`"${rawTicketId}" is not one of the backlog tickets you were given this run.`);
      const patch: board.WorkItemPatch = {};
      if (title) patch.title = title;
      if (description) patch.description = description;
      if (acceptanceCriteria) patch.acceptanceCriteria = acceptanceCriteria;
      if (!Object.keys(patch).length) return fail("Nothing to revise -- provide at least one of title, description, or acceptanceCriteria.");
      const item = await board.updateWorkItem(ticketId, patch);
      if (!item) return fail(`Ticket "${ticketId}" no longer exists.`);
      session.actions.push(`revised "${item.title}"`);
      return ok(`Revised "${item.title}".`);
    },
  );

  server.registerTool(
    "comment_on_ticket",
    {
      title: "Comment on a backlog ticket",
      description: "Leaves a comment explaining why a ticket is being held, or what decision it's still waiting on. Only comment when there's something new to say -- do not repeat an unchanged blocker you already noted on a previous pass.",
      inputSchema: {
        ticketId: z.string().describe("The work item id."),
        body: z.string().describe("The comment text."),
      },
    },
    async ({ ticketId: rawTicketId, body }) => {
      const ticketId = resolveId(rawTicketId, session.validTicketIds);
      if (!ticketId) return fail(`"${rawTicketId}" is not one of the backlog tickets you were given this run.`);
      const comment = await board.addComment(ticketId, session.agentId, session.agentName, body);
      if (!comment) return fail(`Ticket "${ticketId}" no longer exists.`);
      session.actions.push(`commented on a ticket`);
      return ok("Comment added.");
    },
  );

  registerRecordFact(server, session);
  return server;
}
