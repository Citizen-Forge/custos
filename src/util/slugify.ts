/** Lowercase, collapse everything that isn't [a-z0-9] into a single "-",
 *  and trim leading/trailing "-". The shared core of every slug this
 *  gateway generates (workspace directory names in remote/projects.ts,
 *  git branch names in pm/worktrees.ts) -- callers apply their own
 *  fallback-when-empty and any further formatting (truncation, suffixes)
 *  on top of this. */
export function slugifyCore(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
