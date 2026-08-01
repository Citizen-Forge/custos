import * as projects from "../remote/projects.js";
import { ensureProjectAgents } from "./agents.js";
import { updateSettings } from "./project-settings.js";
import { cloneInto } from "./worktrees.js";
import { resolveAgentEnv } from "./vault.js";
import { writeFact } from "./facts.js";
import type { Project } from "../remote/projects.js";

export interface CreateProjectParams {
  name: string;
  dirName?: string;
  repoUrl?: string;
  description?: string;
}

export interface CreateProjectResult {
  project: Project;
  warnings: string[];
  surveying: boolean;
}

/**
 * Creates a project, optionally around an existing repository, seeds its
 * built-in role agents, and kicks off a codebase survey when a clone
 * succeeds. Shared by the admin HTTP route and the MCP `create_project`
 * tool so the two entry points can't drift -- see project-routes.ts and
 * mcp/server.ts.
 */
export async function createProjectWithSetup(
  params: CreateProjectParams,
  onSurveyRequested?: (projectId: string) => void,
): Promise<CreateProjectResult> {
  const project = await projects.createProject(params.name.trim(), params.dirName);

  // Seed the built-in role agents up front so the project's four tabs are
  // all functional the moment it exists.
  await ensureProjectAgents(project.id);

  const warnings: string[] = [];
  if (params.repoUrl?.trim()) {
    try {
      // Clone with the project's own git credentials so a private repo
      // works without the URL ever carrying a token.
      const env = await resolveAgentEnv(project.id);
      const { defaultBranch } = await cloneInto(project.workspaceDir, params.repoUrl.trim(), env);
      await updateSettings(project.id, { repoUrl: params.repoUrl.trim(), defaultBranch });
      await writeFact({ projectId: project.id, key: "repo.url", value: params.repoUrl.trim(), category: "repo" });
      await writeFact({ projectId: project.id, key: "repo.defaultBranch", value: defaultBranch, category: "repo" });
    } catch (err) {
      // The project still exists and is usable -- a failed clone is worth
      // reporting, not worth destroying everything else that succeeded.
      warnings.push(`Could not clone ${params.repoUrl}: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  if (params.description?.trim()) {
    await writeFact({ projectId: project.id, key: "project.description", value: params.description.trim(), category: "docs" });
  }

  // Survey an existing codebase so the first real ticket isn't also the
  // first attempt at working out how to build and test it.
  const surveying = !warnings.length && !!params.repoUrl?.trim();
  if (surveying) void onSurveyRequested?.(project.id);

  return { project, warnings, surveying };
}
