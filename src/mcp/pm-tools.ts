import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as board from "../pm/board.js";
import * as agentStore from "../pm/agents.js";
import { proposeFact, approveFact, rejectFact, FACT_CATEGORIES } from "../pm/facts.js";
import type { Complexity } from "../pm/types.js";

const PORT = process.env.PORT ?? "8787";

/**
 * Replaces the old design for groomBacklog/assignReady, where the model had
 * to hold every decision in its head and emit one giant JSON block at the
 * end of the run. Observed live on the local fallback model
 * (qwen3.5:9b-q4_K_M): three rounds of increasingly forceful prompt
 * engineering ("you have no tools", "no prose", "OUTPUT ONLY THE BLOCK")
 * still failed intermittently -- the model would produce good reasoning, or
 * a generic chat greeting, or narrate its intent, and never reliably reach
 * the closing fence. Tool-calling is a much more heavily-trained model
 * capability than "remember to end with formatted JSON eventually", and
 * each call lands immediately rather than depending on the model holding
 * together a single well-formed blob for the whole run -- there's no
 * "ran out of length before reaching the block" failure mode left, because
 * there's no block.
 *
 * Sessions are per-run, in-memory, and single-use in spirit (see
 * releaseSession) -- there's nothing here that needs to survive a process
 * restart, matching auth/mcp-key.ts's internal key precedent.
 */

const SESSION_TTL_MS = 45 * 60_000; // matches RUN_TIMEOUT_MS's ceiling with headroom

interface BaseSession {
  token: string;
  projectId: string;
  agentId: string;
  agentName: string;
  expiresAt: number;
  /** Human-readable lines describing each successful tool call, folded
   *  into one activity-log line after the run instead of many small ones. */
  actions: string[];
}

export interface GroomSession extends BaseSession {
  kind: "groom";
  validTicketIds: Set<string>;
}

export interface CurateSession extends BaseSession {
  kind: "curate";
  validPendingIds: Set<string>;
}

export interface AssignSession extends BaseSession {
  kind: "assign";
  validTicketIds: Set<string>;
  fallbackSetNames: Set<string>;
  knownAgentIds: Set<string>;
  /** Fallback set NAMES whose resolved primary pick is currently exhausted
   *  (rate-limited, cooling, at capacity) -- precomputed by the caller
   *  against the live GatewayConfig + model-registry availability, since
   *  this module deliberately doesn't import runtime.ts. Checked against
   *  an agent's `fallbackSet` field directly, which works uniformly for
   *  both existing roster agents and ones create_engineer just made in
   *  this same run (both are assigned a set name from the same menu). */
  unavailableFallbackSets: Set<string>;
  /** Decremented on every successful assign_ticket call; assign_ticket
   *  rejects once this hits zero. Mirrors the old `slots` counter that
   *  used to gate the parsed-JSON `assignments` loop. */
  slotsRemaining: number;
}

type PmSession = GroomSession | AssignSession | CurateSession;

const sessions = new Map<string, PmSession>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}

function newToken(): string {
  return `custos_pm_${randomBytes(24).toString("base64url")}`;
}

export function mintGroomSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validTicketIds: Set<string>;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "groom", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

export function mintAssignSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validTicketIds: Set<string>;
  fallbackSetNames: Set<string>;
  knownAgentIds: Set<string>;
  unavailableFallbackSets: Set<string>;
  slotsRemaining: number;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "assign", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

export function mintCurateSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validPendingIds: Set<string>;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "curate", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

/** Returns the accumulated action log and forgets the session. Call once
 *  the run has finished (succeeded, failed, or timed out) -- a session left
 *  around after that point can't be reached by anything except a stale
 *  spawned process, and expiry would eventually clean it up anyway, but
 *  releasing promptly keeps the map from growing with every tick. */
export function releaseSession(token: string): string[] {
  const session = sessions.get(token);
  sessions.delete(token);
  return session?.actions ?? [];
}

/** Looks up a session by its bearer token without consuming it -- the route
 *  handler uses this to decide which tool set to serve (groom vs assign);
 *  the session itself is only released once, explicitly, after the run. */
export function lookupSession(token: string): PmSession | null {
  sweepExpired();
  return sessions.get(token) ?? null;
}

/** The `--mcp-config` inline JSON a groomBacklog/assignReady run's spawned
 *  turn gets, scoped to exactly this one run via the token -- see
 *  buildPortfolioMcpConfig for the sibling pattern (same shape, different
 *  endpoint and a per-run token instead of the process-lifetime one). */
export function buildPmMcpConfig(token: string): string {
  return JSON.stringify({
    mcpServers: {
      custos_pm: {
        type: "http",
        url: `http://localhost:${PORT}/mcp/pm-run`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}

function ok(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

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
    async ({ ticketId }) => {
      if (!session.validTicketIds.has(ticketId)) return fail(`"${ticketId}" is not one of the backlog tickets you were given this run.`);
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
    async ({ ticketId, title, description, acceptanceCriteria }) => {
      if (!session.validTicketIds.has(ticketId)) return fail(`"${ticketId}" is not one of the backlog tickets you were given this run.`);
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
    async ({ ticketId, body }) => {
      if (!session.validTicketIds.has(ticketId)) return fail(`"${ticketId}" is not one of the backlog tickets you were given this run.`);
      const comment = await board.addComment(ticketId, session.agentId, session.agentName, body);
      if (!comment) return fail(`Ticket "${ticketId}" no longer exists.`);
      session.actions.push(`commented on a ticket`);
      return ok("Comment added.");
    },
  );

  registerRecordFact(server, session);
  return server;
}

/** Tools for sizing and assigning ready tickets: create/tune engineers and
 *  assign tickets to them, plus the shared record_fact. The engineer-count
 *  ceiling (`slotsRemaining`) is enforced here the same way the old parsed-
 *  JSON loop enforced it -- assign_ticket rejects once it hits zero, and
 *  the model gets that as an immediate tool result instead of having the
 *  assignment silently dropped after the fact. */
export function buildAssignToolsServer(session: AssignSession): McpServer {
  const server = new McpServer({ name: "custos-pm", version: "1.0.0" });

  server.registerTool(
    "create_engineer",
    {
      title: "Create a new engineer agent",
      description: "Creates a new engineer agent on this project, to assign tickets to via assign_ticket. Returns the new agent's id.",
      inputSchema: {
        name: z.string().describe("Short human-readable name."),
        fallbackSet: z.string().describe("Exactly one of the fallback set names from the model menu in your prompt."),
        specialty: z.string().optional().describe("One line: what this agent is for."),
        maxComplexity: z.enum(["low", "medium", "high"]).describe("The highest complexity ticket this agent should take."),
        systemPrompt: z.string().optional().describe("Extra instructions appended to the standard engineer prompt."),
      },
    },
    async ({ name, fallbackSet, specialty, maxComplexity, systemPrompt }) => {
      if (!session.fallbackSetNames.has(fallbackSet)) {
        return fail(`"${fallbackSet}" is not one of the fallback sets on the model menu. Use one of: ${[...session.fallbackSetNames].join(", ")}.`);
      }
      const created = await agentStore.createAgent({
        projectId: session.projectId,
        role: "engineer",
        name,
        fallbackSet,
        specialty: specialty ?? null,
        maxComplexity: (maxComplexity as Complexity) ?? "medium",
        systemPrompt: systemPrompt ?? "",
        createdBy: "engineering-manager",
      });
      session.knownAgentIds.add(created.id);
      session.actions.push(`created engineer "${created.name}"`);
      return ok(`Created engineer "${created.name}" (id: ${created.id}).`);
    },
  );

  server.registerTool(
    "assign_ticket",
    {
      title: "Assign a ready ticket to an engineer",
      description: "Sizes and assigns a ticket from the ready column to an engineer (existing or just created via create_engineer). Starts the engineer working immediately, in its own isolated checkout.",
      inputSchema: {
        workItemId: z.string().describe("The ticket's id, from the ready column in your prompt."),
        agentId: z.string().describe("The engineer's id -- from your current roster, or returned by create_engineer this run."),
        complexity: z.enum(["low", "medium", "high"]).describe("Your sizing of this ticket."),
        rationale: z.string().optional().describe("One line: why this agent, at this cost, for this ticket."),
      },
    },
    async ({ workItemId, agentId, complexity, rationale }) => {
      if (session.slotsRemaining <= 0) return fail("No engineer slots remaining this pass -- this project's concurrency ceiling is already met. Leave remaining tickets in ready for next time.");
      if (!session.validTicketIds.has(workItemId)) return fail(`"${workItemId}" is not one of the ready tickets you were given this run.`);
      if (!session.knownAgentIds.has(agentId)) return fail(`"${agentId}" is not an engineer on your current roster or one you created this run.`);
      const assignee = await agentStore.getAgent(agentId);
      if (!assignee) return fail(`Agent "${agentId}" no longer exists.`);
      if (assignee.fallbackSet && session.unavailableFallbackSets.has(assignee.fallbackSet)) {
        return fail(`${assignee.name} runs on fallback set "${assignee.fallbackSet}", which is currently exhausted. Pick a different engineer or fallback set.`);
      }
      const item = await board.transitionWorkItem(workItemId, "in_progress", agentId, rationale || "assigned by engineering manager");
      if (!item) return fail(`Ticket "${workItemId}" no longer exists or already moved.`);
      await board.updateWorkItem(workItemId, { complexity: complexity as Complexity, assigneeAgentId: agentId });
      await agentStore.recordAssignment(agentId);
      session.slotsRemaining -= 1;
      session.actions.push(`assigned "${item.title}" to ${assignee.name}`);
      return ok(`Assigned "${item.title}" to ${assignee.name}. ${session.slotsRemaining} slot(s) remaining this pass.`);
    },
  );

  server.registerTool(
    "tune_engineer",
    {
      title: "Tune an existing engineer",
      description: "Appends a standing instruction and/or changes the fallback set or complexity ceiling for an existing engineer.",
      inputSchema: {
        agentId: z.string().describe("The engineer's id."),
        note: z.string().optional().describe("Instruction appended to that agent's prompt."),
        fallbackSet: z.string().optional().describe("New fallback set, if it needs one."),
        maxComplexity: z.enum(["low", "medium", "high"]).optional().describe("New complexity ceiling, if it needs one."),
      },
    },
    async ({ agentId, note, fallbackSet, maxComplexity }) => {
      if (!session.knownAgentIds.has(agentId)) return fail(`"${agentId}" is not an engineer on your current roster or one you created this run.`);
      if (fallbackSet && !session.fallbackSetNames.has(fallbackSet)) {
        return fail(`"${fallbackSet}" is not one of the fallback sets on the model menu.`);
      }
      if (note) await agentStore.appendAgentNote(agentId, note);
      const patch: agentStore.AgentPatch = {};
      if (maxComplexity) patch.maxComplexity = maxComplexity as Complexity;
      if (fallbackSet) patch.fallbackSet = fallbackSet;
      if (Object.keys(patch).length) await agentStore.updateAgent(agentId, patch);
      session.actions.push(`tuned an engineer`);
      return ok("Updated.");
    },
  );

  registerRecordFact(server, session);
  return server;
}

function registerRecordFact(server: McpServer, session: PmSession): void {
  server.registerTool(
    "record_fact",
    {
      title: "Propose a durable project fact",
      description: "Proposes an entry for this project's shared knowledge store. It is reviewed by a curator before other agents see it -- use only for something durable and cross-cutting that will still be true and useful later, not a note about this specific ticket.",
      inputSchema: {
        key: z.string().describe("Short stable key, e.g. \"repo.url\" or \"test.command\"."),
        value: z.string().describe("The fact's value. Overwrite an existing key when you find its current value is wrong."),
        category: z.enum(FACT_CATEGORIES as [string, ...string[]]).optional().describe("Optional grouping label."),
      },
    },
    async ({ key, value, category }) => {
      if (!key.trim() || !value.trim()) return fail("Both key and value are required.");
      await proposeFact({ projectId: session.projectId, key: key.trim(), value: value.trim(), category: category as never, writtenBy: session.agentId, writtenByLabel: session.agentName });
      return ok(`Proposed fact "${key}" for review.`);
    },
  );
}

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
    async ({ factId, key, value, category }) => {
      if (!session.validPendingIds.has(factId)) return fail(`"${factId}" is not one of the pending facts you were given this run.`);
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
    async ({ factId, reason }) => {
      if (!session.validPendingIds.has(factId)) return fail(`"${factId}" is not one of the pending facts you were given this run.`);
      const removed = await rejectFact(factId);
      if (!removed) return fail(`Pending fact "${factId}" no longer exists or was already reviewed.`);
      session.actions.push(`rejected a proposal${reason ? ` (${reason})` : ""}`);
      return ok("Rejected.");
    },
  );

  return server;
}

