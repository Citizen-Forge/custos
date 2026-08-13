import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EngineerSession } from "./session.js";
import { ok, registerRecordFact } from "./shared.js";

/** Tools for the engineer role. Unlike groom/assign/curate, an engineer's
 *  job genuinely needs its full normal toolkit (Bash/Read/Write/Edit --
 *  see agent-runner.ts: "custos-engineer" is deliberately never added to
 *  TOOL_FREE_TAGS or DISALLOWED_TOOLS_BY_TAG). What moves off the old
 *  trailing-JSON-block pattern is just how the run reports its outcome:
 *  report_ready_for_qa/report_blocked replace the closing `custos-engineer`
 *  fenced block runEngineer used to parse out of the transcript.
 *  Confirmed live: a run can do the entire real job correctly (rebase,
 *  resolve conflicts, tests, typecheck, demo, commit) and then simply never
 *  emit that closing block -- the exact same "good work, no block" failure
 *  mode groom/assign/curate had before their own tool-driven redesign, just
 *  reached by a longer, tool-heavy conversation instead of a short
 *  decision-only one. A tool call either lands or it doesn't; there's no
 *  "ran out of length before reaching the fence" failure mode left. */
export function buildEngineerToolsServer(session: EngineerSession): McpServer {
  const server = new McpServer({ name: "custos-pm", version: "1.0.0" });

  server.registerTool(
    "report_ready_for_qa",
    {
      title: "Report this ticket ready for QA",
      description: "Call this once you're done: acceptance criteria met, branch pushed, pull request open. This is how a run reports its result -- there is no other expected output format, and nothing happens automatically just because the acceptance criteria look met in your own read of the diff.",
      inputSchema: {
        summary: z.string().describe("Markdown: what you changed, why, and how to verify it."),
        branch: z.string().optional().describe("The branch name you pushed."),
        prUrl: z.string().optional().describe("The pull request URL."),
        subtasks: z.array(z.object({ title: z.string(), done: z.boolean() })).optional().describe("Updated subtask checklist, if the ticket has one."),
        followUps: z.array(z.string()).optional().describe("Unrelated problems you noticed and deliberately did not fix."),
      },
    },
    async ({ summary, branch, prUrl, subtasks, followUps }) => {
      session.outcome = {
        status: "ready_for_qa",
        summary,
        branch: branch ?? null,
        prUrl: prUrl ?? null,
        subtasks: subtasks ?? [],
        followUps: followUps ?? [],
      };
      session.actions.push("reported ready for QA");
      return ok("Recorded. The run is complete -- no further action needed.");
    },
  );

  server.registerTool(
    "report_blocked",
    {
      title: "Report this ticket blocked",
      description: "Call this when you cannot proceed without a decision only a human or the product owner can make. The ticket goes back to the backlog with your reason attached; whatever you've already committed to the branch is preserved.",
      inputSchema: {
        reason: z.string().describe("The specific question or missing thing that's blocking you."),
        followUps: z.array(z.string()).optional().describe("Unrelated problems you noticed and deliberately did not fix."),
      },
    },
    async ({ reason, followUps }) => {
      session.outcome = { status: "blocked", reason, followUps: followUps ?? [] };
      session.actions.push(`reported blocked: ${reason}`);
      return ok("Recorded. The run is complete -- no further action needed.");
    },
  );

  registerRecordFact(server, session);
  return server;
}
