/**
 * Resolves the deployed commit hash. Prefers the COMMIT_SHA env var
 * (set as a Docker build arg), falls back to live `git rev-parse`
 * (works in local dev but not inside the container unless .git is
 * copied -- we don't, because it's large). Returns null when neither
 * source is available.
 */
export async function getCommitHash(): Promise<string | null> {
  let commit = process.env.COMMIT_SHA;
  if (!commit) {
    try {
      const { execSync } = await import("node:child_process");
      commit = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      /* ignore -- fall back to unknown */
    }
  }
  return commit || null;
}
