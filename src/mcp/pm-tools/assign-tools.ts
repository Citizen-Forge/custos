import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as board from "../../pm/board.js";
import * as agentStore from "../../pm/agents.js";
import type { Complexity } from "../../pm/types.js";
import type { AssignSession } from "./session.js";
import { fail, ok, registerRecordFact, resolveId } from "./shared.js";

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
    async ({ workItemId: rawWorkItemId, agentId: rawAgentId, complexity, rationale }) => {
      if (session.slotsRemaining <= 0) return fail("No engineer slots remaining this pass -- this project's concurrency ceiling is already met. Leave remaining tickets in ready for next time.");
      const workItemId = resolveId(rawWorkItemId, session.validTicketIds);
      if (!workItemId) return fail(`"${rawWorkItemId}" is not one of the ready tickets you were given this run.`);
      const agentId = resolveId(rawAgentId, session.knownAgentIds);
      if (!agentId) return fail(`"${rawAgentId}" is not an engineer on your current roster or one you created this run.`);
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
    async ({ agentId: rawAgentId, note, fallbackSet, maxComplexity }) => {
      const agentId = resolveId(rawAgentId, session.knownAgentIds);
      if (!agentId) return fail(`"${rawAgentId}" is not an engineer on your current roster or one you created this run.`);
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
