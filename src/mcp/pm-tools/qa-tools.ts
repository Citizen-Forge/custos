import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { QaSession } from "./session.js";
import { ok, registerRecordFact } from "./shared.js";

/** Tools for the QA role. Same motivation as engineer-tools.ts's
 *  report_ready_for_qa/report_blocked: report_qa_verdict replaces the
 *  closing `custos-qa` fenced JSON block runQa used to parse out of the
 *  transcript. Confirmed live on the exact same local fallback model
 *  (qwen3.5:9b-q4_K_M) that motivated the engineer migration: a QA run
 *  can genuinely review the diff (real Bash/Read tool calls, real
 *  `gh pr comment` posts) for up to the full 90-minute run ceiling and
 *  never once emit the closing block -- "the agent did not return a
 *  valid `custos-qa` block" on a run that otherwise did real work. QA
 *  keeps Bash/Read/Glob/Grep/Task (see tool-policy.ts's
 *  DISALLOWED_TOOLS_BY_TAG entry for "custos-qa") -- only Write/Edit/
 *  NotebookEdit stay denied, since judging a diff is still not writing
 *  one. */
export function buildQaToolsServer(session: QaSession): McpServer {
  const server = new McpServer({ name: "custos-pm", version: "1.0.0" });

  server.registerTool(
    "report_qa_verdict",
    {
      title: "Report your QA verdict",
      description: "Call this once you've verified the acceptance criteria and reached a verdict. This is how a QA run reports its result -- there is no other expected output format, and nothing happens automatically just because you believe the work passes.",
      inputSchema: {
        verdict: z.enum(["pass", "fail"]).describe("pass transitions the ticket to complete; fail bounces it back to ready for rework."),
        summary: z.string().describe("Markdown: your overall assessment."),
        criteriaChecked: z.array(z.object({
          criterion: z.string(),
          result: z.enum(["pass", "fail"]),
          evidence: z.string(),
        })).optional().describe("Each acceptance criterion you verified, individually -- what you checked and what you found."),
        prComments: z.array(z.string()).optional().describe("Mirrors whatever you already posted via `gh pr comment` during this review, so the ticket detail UI can show them without a second GitHub round-trip. Not how comments actually get posted to the PR -- that's still `gh pr comment`, called directly."),
        followUps: z.array(z.string()).optional().describe("Unrelated problems you noticed and deliberately did not fail the ticket over -- note them here instead so a bug can be raised."),
      },
    },
    async ({ verdict, summary, criteriaChecked, prComments, followUps }) => {
      session.outcome = {
        verdict,
        summary,
        criteriaChecked: criteriaChecked ?? [],
        prComments: prComments ?? [],
        followUps: followUps ?? [],
      };
      session.actions.push(`reported QA verdict: ${verdict}`);
      return ok("Recorded. The run is complete -- no further action needed.");
    },
  );

  registerRecordFact(server, session);
  return server;
}
