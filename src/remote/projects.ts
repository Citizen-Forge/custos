import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";

const WORKSPACE_ROOT = process.env.CUSTOS_WORKSPACE_DIR ?? "/workspace";
const PROJECTS_PATH = process.env.GATEWAY_PROJECTS_PATH ?? "data/projects.json";

export interface Project {
  id: string;
  name: string;
  /** Absolute path, always inside WORKSPACE_ROOT -- this is the cwd every
   * chat under this project spawns `claude` in. */
  workspaceDir: string;
  createdAt: number;
}

async function readAll(): Promise<Project[]> {
  try {
    return JSON.parse(await readFile(PROJECTS_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(projects: Project[]): Promise<void> {
  await mkdir(dirname(PROJECTS_PATH), { recursive: true });
  await writeFile(PROJECTS_PATH, JSON.stringify(projects, null, 2), "utf8");
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** Resolves a project-relative directory name to an absolute path,
 * rejecting anything that escapes WORKSPACE_ROOT (e.g. a hand-crafted
 * "../../etc" dirName) instead of silently clamping it. */
function resolveWorkspaceDir(dirName: string): string {
  const abs = resolve(WORKSPACE_ROOT, dirName);
  const rel = relative(WORKSPACE_ROOT, abs);
  if (rel.startsWith("..")) {
    throw new Error("workspace directory must stay inside the configured workspace root");
  }
  return abs;
}

export async function listProjects(): Promise<Project[]> {
  return readAll();
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await readAll();
  return projects.find((p) => p.id === id) ?? null;
}

export async function createProject(name: string, dirName?: string): Promise<Project> {
  const projects = await readAll();
  const base = slugify(dirName || name);
  let candidate = base;
  let n = 1;
  const taken = new Set(projects.map((p) => p.workspaceDir));
  while (taken.has(resolveWorkspaceDir(candidate))) {
    candidate = `${base}-${++n}`;
  }
  const workspaceDir = resolveWorkspaceDir(candidate);
  await mkdir(workspaceDir, { recursive: true });

  const project: Project = { id: randomBytes(12).toString("base64url"), name, workspaceDir, createdAt: Date.now() };
  projects.push(project);
  await writeAll(projects);
  return project;
}

export async function renameProject(id: string, name: string): Promise<Project | null> {
  const projects = await readAll();
  const project = projects.find((p) => p.id === id);
  if (!project) return null;
  project.name = name;
  await writeAll(projects);
  return project;
}

/** Removes only the tracking entry -- never touches the workspace
 * directory or its files, since those are the user's real project files. */
export async function deleteProject(id: string): Promise<boolean> {
  const projects = await readAll();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  await writeAll(next);
  return true;
}
