// Tools whose effect is always read-only/non-destructive: never worth an LLM
// call or a whitelist entry, always allow.
const ALWAYS_SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "TodoWrite", "WebSearch"]);

export function isAlwaysSafe(toolName: string): boolean {
  return ALWAYS_SAFE_TOOLS.has(toolName);
}

/** Groups similar actions together so the whitelist generalizes instead of
 * caching one entry per distinct file path or exact command line. */
export function signatureFor(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const firstWord = toolInput.command.trim().split(/\s+/)[0] ?? "";
    return `Bash:${firstWord}`;
  }
  return toolName;
}
