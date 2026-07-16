import type { ProviderRouter } from "../providers/router.js";
import { isAlwaysSafeTool, isSafeBashCommand } from "./safety.js";
import { classifyAction } from "./classifier.js";
import type { AskTracker } from "./ask-tracker.js";

// Matches Claude Code's PreToolUse hook stdin/response contract
// (code.claude.com/docs/en/hooks.md).
export interface PreToolUseHookInput {
  session_id: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_mode: string;
  cwd: string;
}

export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

// No allow/deny caching by design: only a small, argument-invariant set of
// verbs bypasses the classifier. Everything else -- including a command
// this exact classifier already saw and allowed a moment ago -- is
// re-classified live, because for commands like `rm`/`chmod`/`curl` safety
// depends on arguments, not the verb, and caching by verb would let one
// benign invocation silently whitelist a catastrophic one later.
export function createPreToolUseHandler(router: ProviderRouter, askTracker: AskTracker) {
  return async function handle(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const respond = (permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason: string): PreToolUseHookOutput => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
    });

    if (isAlwaysSafeTool(input.tool_name)) {
      return respond("allow", "always-safe read-only tool");
    }

    if (input.tool_name === "Bash" && typeof input.tool_input.command === "string" && isSafeBashCommand(input.tool_input.command)) {
      return respond("allow", "safe read-only verb, no shell composition");
    }

    const { decision, reason } = await classifyAction(router, input.tool_name, input.tool_input);
    if (decision === "ask") {
      askTracker.recordAsk(input.session_id, input.tool_name, input.tool_input, reason);
    }
    return respond(decision, reason);
  };
}
