// Tools whose effect is always read-only/non-destructive regardless of
// input: never worth an LLM call.
const ALWAYS_SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "NotebookRead", "TodoWrite", "WebSearch",
  // Read-only custos MCP tools (mcp/server.ts) -- a portfolio chat's own
  // self-referential MCP connection only ever queries custos's own data
  // through these, never mutates anything, so they're safe the same way
  // Read/Grep are. The write tools (create_project, submit_idea,
  // claim_ticket, submit_for_qa) deliberately stay off this list and go
  // through the normal ask-a-human classifier flow -- they take real
  // actions a human should confirm, the same posture the admin UI's own
  // buttons for these actions already has.
  "mcp__custos__list_projects", "mcp__custos__list_tickets",
]);

export function isAlwaysSafeTool(toolName: string): boolean {
  return ALWAYS_SAFE_TOOLS.has(toolName);
}

// Bash verbs that are safe in EVERY invocation regardless of flags -- no
// destructive flag variants exist for any of these (contrast with e.g.
// `find -delete`, `cp -f`, `sort -o`, `tee`, `git push --force`, all of
// which share a "safe-looking" first word with genuinely safe uses).
// Deliberately does not include git/npm/node/python/etc: their first word
// says nothing about whether the actual invocation is safe, so those
// always go through the classifier.
const SAFE_BASH_VERBS = new Set(["pwd", "ls", "echo", "cat", "head", "tail", "wc", "whoami", "date", "which"]);

// Shell metacharacters that let an otherwise-safe verb do something
// unsafe via composition (redirect into a file, chain another command,
// pipe into something else, substitute a command).
const SHELL_COMPOSITION_PATTERN = /[><|;`]|&&|\$\(/;

export function isSafeBashCommand(command: string): boolean {
  if (SHELL_COMPOSITION_PATTERN.test(command)) return false;
  const verb = command.trim().split(/\s+/)[0] ?? "";
  return SAFE_BASH_VERBS.has(verb);
}
