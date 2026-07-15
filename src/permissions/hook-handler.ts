import type { ProviderRouter } from "../providers/router.js";
import { Whitelist } from "./whitelist.js";
import { isAlwaysSafe, signatureFor } from "./signature.js";
import { classifyAction } from "./classifier.js";

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

export function createPreToolUseHandler(router: ProviderRouter) {
  const whitelist = new Whitelist();

  return async function handle(input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const respond = (permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason: string): PreToolUseHookOutput => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
    });

    if (isAlwaysSafe(input.tool_name)) {
      return respond("allow", "always-safe read-only tool");
    }

    const signature = signatureFor(input.tool_name, input.tool_input);
    const cached = await whitelist.get(signature);
    if (cached) {
      return respond(cached.decision, `whitelisted: ${cached.reason}`);
    }

    const { decision, reason } = await classifyAction(router, input.tool_name, input.tool_input);
    if (decision === "allow" || decision === "deny") {
      await whitelist.set(signature, decision, reason);
    }
    return respond(decision, reason);
  };
}
