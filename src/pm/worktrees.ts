import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const run = promisify(execFile);

const WORKSPACE_ROOT = process.env.CUSTOS_WORKSPACE_DIR ?? "/workspace";

/** Worktrees live beside the projects rather than inside any one of them:
 * a checkout nested in its own repo confuses tooling (test globs, linters,
 * the agent's own file search) and shows up as untracked noise in every
 * diff the engineer produces. */
const WORKTREE_ROOT = join(WORKSPACE_ROOT, ".custos-worktrees");

export interface Workspace {
  /** Directory the agent actually runs in. */
  cwd: string;
  /** Branch checked out there, when it's an isolated worktree. */
  branch: string | null;
  /** False when the project isn't a git repository and the agent has to
   * work directly in the shared project directory -- which is why
   * concurrency is clamped to one engineer in that case. */
  isolated: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Whether this directory can hand out isolated checkouts. A repository with
 * no commits yet can't: its HEAD is unborn, so there is nothing for a
 * worktree to be created from. That's exactly the state a brand-new project
 * is in, so it's a normal case rather than an error -- the first engineer
 * works in the project directory itself and lands the initial commit, and
 * every ticket after that gets its own checkout.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function branchName(item: { id: string; type: string; title: string }): string {
  const slug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `custos/${item.type}-${slug || "work"}-${item.id.toLowerCase()}`;
}

function worktreePath(projectId: string, itemId: string): string {
  return resolve(WORKTREE_ROOT, projectId, itemId);
}

/**
 * Gives one ticket its own checkout so several engineers can work the same
 * project at once. A git worktree rather than a clone: it shares the
 * object store with the project's repository, so creating one is close to
 * free however large the history is, and the branch the engineer commits to
 * is immediately visible from the main working copy without a fetch.
 *
 * Idempotent -- an engineer picking a ticket back up after a QA bounce gets
 * the same checkout, with its work still in it.
 */
export async function ensureWorkspace(
  projectDir: string,
  projectId: string,
  item: { id: string; type: string; title: string },
  defaultBranch: string,
): Promise<Workspace> {
  if (!(await isGitRepo(projectDir))) {
    return { cwd: projectDir, branch: null, isolated: false };
  }

  const dir = worktreePath(projectId, item.id);
  const branch = branchName(item);

  // Already registered for this path? Reuse it as-is.
  const existing = await listWorktrees(projectDir);
  if (existing.some((w) => resolve(w) === dir)) {
    return { cwd: dir, branch, isolated: true };
  }

  await mkdir(join(WORKTREE_ROOT, projectId), { recursive: true });
  // A stale directory with no worktree registration (a container died
  // mid-run) would make `worktree add` fail; clear it first.
  await rm(dir, { recursive: true, force: true });

  const startPoint = (await branchExists(projectDir, defaultBranch)) ? [defaultBranch] : [];
  if (await branchExists(projectDir, branch)) {
    await git(projectDir, ["worktree", "add", dir, branch]);
  } else {
    await git(projectDir, ["worktree", "add", "-b", branch, dir, ...startPoint]);
  }
  return { cwd: dir, branch, isolated: true };
}

async function branchExists(projectDir: string, branch: string): Promise<boolean> {
  try {
    await git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function listWorktrees(projectDir: string): Promise<string[]> {
  try {
    const out = await git(projectDir, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  } catch {
    return [];
  }
}

/**
 * Releases a ticket's checkout. The branch is deliberately left behind --
 * it holds the actual work, and it's what the pull request points at, so
 * removing it would throw away the thing the whole run produced.
 */
export async function releaseWorkspace(projectDir: string, projectId: string, itemId: string): Promise<void> {
  const dir = worktreePath(projectId, itemId);
  try {
    await git(projectDir, ["worktree", "remove", "--force", dir]);
  } catch {
    // Not registered (never created, or already removed) -- fall through to
    // clearing the directory so a half-removed worktree can't block a
    // later `worktree add` at the same path.
  }
  await rm(dir, { recursive: true, force: true });
  try {
    await git(projectDir, ["worktree", "prune"]);
  } catch {
    // Best effort; a stale registration is harmless until the path is reused.
  }
}

/**
 * Clones an existing repository into a new project's workspace.
 *
 * Takes the environment rather than reading the vault itself so the caller
 * decides which credentials apply -- a private repo needs the project's git
 * token, and passing it explicitly keeps this function honest about the
 * fact that it can reach the network with a credential.
 */
export async function cloneInto(dir: string, repoUrl: string, env: Record<string, string>): Promise<{ defaultBranch: string }> {
  await mkdir(dir, { recursive: true });
  // `git clone` into a non-empty directory fails outright, which is the
  // right behaviour -- refuse rather than merge into whatever is there.
  await run("git", ["clone", repoUrl, "."], { cwd: dir, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  return { defaultBranch: await detectDefaultBranch(dir) };
}

/** The branch the remote actually points HEAD at, rather than assuming
 * "main" and having every later branch cut from the wrong place. */
export async function detectDefaultBranch(dir: string): Promise<string> {
  try {
    const head = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branch = head.split("/").pop();
    if (branch) return branch;
  } catch {
    // No remote HEAD (a bare init, or a clone that didn't set it).
  }
  try {
    return await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "main";
  }
}

/** Drops every checkout belonging to a project, for project deletion. */
export async function releaseProjectWorkspaces(projectDir: string, projectId: string): Promise<void> {
  for (const dir of await listWorktrees(projectDir)) {
    if (!resolve(dir).startsWith(resolve(WORKTREE_ROOT, projectId))) continue;
    try {
      await git(projectDir, ["worktree", "remove", "--force", dir]);
    } catch {
      // Keep going -- one stuck worktree shouldn't strand the others.
    }
  }
  await rm(resolve(WORKTREE_ROOT, projectId), { recursive: true, force: true });
}
