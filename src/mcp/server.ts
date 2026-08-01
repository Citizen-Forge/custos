import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProjects, getProject } from "../remote/projects.js";
import { createIdea } from "../pm/ideas.js";
import { createProjectWithSetup } from "../pm/project-creation.js";
import { listWorkItems, getWorkItem, updateWorkItem, transitionWorkItem, addComment } from "../pm/board.js";
import { getSettings } from "../pm/project-settings.js";
import { ensureWorkspace } from "../pm/worktrees.js";
import { HUMAN_ASSIGNEE_ID } from "../pm/types.js";
import { getInternalMcpKey } from "../auth/mcp-key.js";
import type { Orchestrator } from "../pm/orchestrator.js";

const PORT = process.env.PORT ?? "8787";

/** The `--mcp-config` inline JSON a portfolio chat's spawned turn gets, so
 * it can call back into this same gateway's own /mcp tools over localhost.
 * Authenticated with the process-lifetime internal key, never the
 * operator's own external one (see auth/mcp-key.ts). */
export function buildPortfolioMcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      custos: {
        type: "http",
        url: `http://localhost:${PORT}/mcp`,
        headers: { Authorization: `Bearer ${getInternalMcpKey()}` },
      },
    },
  });
}

/**
 * MCP tools for handing a fully-discussed project idea from an external
 * Claude Code session into custos, as if it had come through the steering
 * column's own chat handoff (see prompts.ts's STEERING_PROMPT and
 * session-manager.ts's captureHandoff -- this is the same drop point,
 * `ideas.createIdea` + `orchestrator.planIdea`, just reached directly
 * instead of via an LLM parsing its own free text for a handoff fence).
 *
 * Three tools rather than one "do everything" tool: list_projects lets the
 * calling session resolve a project by name without the human having to
 * paste a GUID, and create_project vs. submit_idea map onto the two branches
 * the user actually asked for ("push as a new project, or into an existing
 * one") as separate, composable steps -- which also means a partial failure
 * (e.g. project created but the idea submission errors) is legible instead
 * of being one opaque combined call.
 */
export function buildMcpServer(orchestrator: Orchestrator): McpServer {
  const server = new McpServer({ name: "custos", version: "1.0.0" });

  server.registerTool(
    "list_projects",
    {
      title: "List custos projects",
      description: "Lists every project currently configured in custos, so a project can be identified by name before submitting an idea to it.",
      inputSchema: {},
    },
    async () => {
      const projects = await listProjects();
      const lines = projects.length
        ? projects.map((p) => `- ${p.name} (id: ${p.id})`).join("\n")
        : "No projects exist yet -- use create_project to make one.";
      return { content: [{ type: "text", text: lines }] };
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a new custos project",
      description: "Creates a new project in custos, optionally cloning an existing git repository into it. Seeds the built-in role agents (steering, product owner, engineering manager, engineer, QA, devops) so the project is immediately functional.",
      inputSchema: {
        name: z.string().describe("Project name."),
        dirName: z.string().optional().describe("Workspace directory name; slugified from name if omitted."),
        repoUrl: z.string().optional().describe("Git repository URL to clone into the new project's workspace."),
        description: z.string().optional().describe("Short description, recorded as a project fact."),
      },
    },
    async ({ name, dirName, repoUrl, description }) => {
      try {
        const result = await createProjectWithSetup(
          { name, dirName, repoUrl, description },
          (projectId) => orchestrator.surveyProject(projectId),
        );
        const warningsText = result.warnings.length ? `\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "";
        return {
          content: [{
            type: "text",
            text: `Created project "${result.project.name}" (id: ${result.project.id}).${result.surveying ? " Codebase survey started." : ""}${warningsText}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to create project: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "submit_idea",
    {
      title: "Submit a project idea to custos",
      description: "Drops a fully-discussed idea into an existing project's roadmap inbox, exactly as if it had come through the steering column's chat handoff, and immediately kicks off product-owner planning (breaking it into epics/stories on the board) rather than waiting for the next poll tick. Use list_projects first to find the target project's id.",
      inputSchema: {
        projectId: z.string().describe("The target project's id (see list_projects)."),
        title: z.string().describe("Short imperative name for the idea."),
        brief: z.string().describe("The distilled brief: problem, proposed shape, constraints ruled out, open questions, success criteria. Written the way a product owner would want to read it -- not a raw transcript."),
      },
    },
    async ({ projectId, title, brief }) => {
      const project = await getProject(projectId);
      if (!project) {
        return { content: [{ type: "text", text: `No project with id "${projectId}" -- use list_projects to find the right id.` }], isError: true };
      }
      const idea = await createIdea(projectId, title, brief, null);
      void orchestrator.planIdea(projectId, idea.id);
      return {
        content: [{
          type: "text",
          text: `Submitted "${idea.title}" to ${project.name}'s roadmap inbox (idea id: ${idea.id}) and kicked off product-owner planning. Progress will show up in custos's activity feed.`,
        }],
      };
    },
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List tickets in a custos project",
      description: "Lists work items (epics/stories/bugs) on a project's board, optionally filtered by status. Use this to resolve a ticket the user refers to by name into its id before calling claim_ticket.",
      inputSchema: {
        projectId: z.string().describe("The project's id (see list_projects)."),
        status: z.enum(["backlog", "ready", "in_progress", "qa", "complete"]).optional().describe("Filter to one board status. Omit to list everything."),
      },
    },
    async ({ projectId, status }) => {
      const items = (await listWorkItems(projectId)).filter((i) => !status || i.status === status);
      const lines = items.length
        ? items.map((i) => `- [${i.status}] ${i.title} (id: ${i.id}, type: ${i.type}${i.assigneeAgentId ? `, assignee: ${i.assigneeAgentId}` : ""})`).join("\n")
        : "No matching tickets.";
      return { content: [{ type: "text", text: lines }] };
    },
  );

  server.registerTool(
    "claim_ticket",
    {
      title: "Claim a ticket to work on yourself",
      description: "Claims an existing ticket for the human operating this session instead of an engineer agent -- moves it to in_progress and hands back the git branch to work on, the same branch an engineer agent would have used. Only works on tickets currently in backlog or ready. Use submit_for_qa when the work is done.",
      inputSchema: {
        workItemId: z.string().describe("The ticket's id (see list_tickets)."),
      },
    },
    async ({ workItemId }) => {
      const item = await getWorkItem(workItemId);
      if (!item) {
        return { content: [{ type: "text", text: `No ticket with id "${workItemId}".` }], isError: true };
      }
      if (item.status !== "backlog" && item.status !== "ready") {
        return {
          content: [{
            type: "text",
            text: `"${item.title}" is currently ${item.status}${item.assigneeAgentId ? ` (assignee: ${item.assigneeAgentId})` : ""} -- only backlog/ready tickets can be claimed.`,
          }],
          isError: true,
        };
      }
      const project = await getProject(item.projectId);
      if (!project) {
        return { content: [{ type: "text", text: `Ticket's project ${item.projectId} no longer exists.` }], isError: true };
      }
      const settings = await getSettings(project.id);
      // Same call, same deterministic branch name, an engineer agent's own
      // run would use (orchestrator.ts's runEngineer) -- see worktrees.ts's
      // branchName(). Idempotent, so re-claiming a ticket someone else
      // (agent or human) already touched reuses the existing branch/worktree
      // rather than creating a conflicting second one.
      const workspace = await ensureWorkspace(project.workspaceDir, project.id, item, settings.defaultBranch);
      await updateWorkItem(workItemId, {
        assigneeAgentId: HUMAN_ASSIGNEE_ID,
        branch: workspace.branch,
        worktreePath: workspace.isolated ? workspace.cwd : null,
      });
      await transitionWorkItem(workItemId, "in_progress", "human", "claimed via MCP");
      const branchInfo = workspace.branch
        ? `Branch: ${workspace.branch} (base: ${settings.defaultBranch}${settings.repoUrl ? `, repo: ${settings.repoUrl}` : ""})`
        : "This project has no repo configured -- work directly in its workspace, no branch to check out.";
      return {
        content: [{
          type: "text",
          text: `Claimed "${item.title}" (${item.type}).\n\n${item.description}\n\nAcceptance criteria:\n${item.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "(none listed)"}\n\n${branchInfo}\n\nWhen done, open a PR and call submit_for_qa with its URL.`,
        }],
      };
    },
  );

  server.registerTool(
    "submit_for_qa",
    {
      title: "Submit claimed work for QA review",
      description: "Marks a ticket you claimed as ready for review -- moves it to the qa status, where custos's QA agent picks it up exactly as it would review an engineer agent's PR (reads the diff via the PR URL, checks it against the ticket's acceptance criteria and the project's architecture conventions, and either passes it or bounces it back to ready with comments).",
      inputSchema: {
        workItemId: z.string().describe("The ticket's id."),
        prUrl: z.string().describe("URL of the pull request to review."),
        branch: z.string().optional().describe("Override the branch on record, if it differs from what claim_ticket returned."),
        summary: z.string().optional().describe("Optional summary of the work, posted as a ticket comment for QA's context."),
      },
    },
    async ({ workItemId, prUrl, branch, summary }) => {
      const item = await getWorkItem(workItemId);
      if (!item) {
        return { content: [{ type: "text", text: `No ticket with id "${workItemId}".` }], isError: true };
      }
      if (item.assigneeAgentId !== HUMAN_ASSIGNEE_ID) {
        return {
          content: [{ type: "text", text: `"${item.title}" wasn't claimed via claim_ticket (assignee: ${item.assigneeAgentId ?? "none"}) -- can't submit it for QA from here.` }],
          isError: true,
        };
      }
      if (item.status !== "in_progress") {
        return { content: [{ type: "text", text: `"${item.title}" is currently ${item.status}, not in_progress -- nothing to submit.` }], isError: true };
      }
      await updateWorkItem(workItemId, { prUrl, ...(branch ? { branch } : {}) });
      if (summary?.trim()) await addComment(workItemId, HUMAN_ASSIGNEE_ID, "Human (via MCP)", summary.trim());
      await transitionWorkItem(workItemId, "qa", "human", "submitted for QA via MCP");
      return {
        content: [{ type: "text", text: `Submitted "${item.title}" for QA review against ${prUrl}. custos's QA agent will pick it up on its next tick.` }],
      };
    },
  );

  return server;
}
