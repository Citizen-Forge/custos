// Small helpers shared by every role's tool-server builder.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { proposeFact, FACT_CATEGORIES } from "../../pm/facts.js";
import type { PmSession } from "./session.js";

export function ok(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}
export function fail(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/** Ticket/agent/fact ids are short random tokens (see store.ts's newId),
 *  but a model asked for one reliably pastes back the whole rendered
 *  heading it read the id from instead -- e.g. `"STORY AXOZKgz7BcEd —
 *  Attacker approach scenario setup"` instead of `"AXOZKgz7BcEd"`,
 *  observed live on two different tools. A random id is effectively never
 *  a substring of unrelated prose, so resolving against the valid set by
 *  substring is safe and turns what would otherwise be a wasted round
 *  trip (or, worse, a plausible-looking id the model then can't recover
 *  from) into a successful call. */
export function resolveId(input: string, validIds: ReadonlySet<string>): string | null {
  if (validIds.has(input)) return input;
  for (const id of validIds) {
    if (input.includes(id)) return id;
  }
  return null;
}

export function registerRecordFact(server: McpServer, session: PmSession): void {
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
