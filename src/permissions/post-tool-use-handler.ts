import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AskTracker } from "./ask-tracker.js";

const LOG_PATH = process.env.GATEWAY_ASK_OUTCOMES_PATH ?? "data/ask-outcomes.jsonl";

export interface PostToolUseHookInput {
  session_id: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  success?: boolean;
}

/**
 * Best-effort observability, not a permission bypass. Claude Code has no
 * documented hook that reports what a human actually clicked at an
 * interactive permission prompt -- PermissionRequest fires BEFORE the
 * dialog, to let a hook preempt it, not after. The only signal available
 * here is whether a call we returned "ask" for went on to execute, which
 * could mean a human said yes, or Claude Code's own permission system
 * approved it independently of us. Logged for later review; never read
 * back into any allow/deny decision.
 */
export function createPostToolUseHandler(tracker: AskTracker) {
  return async function handle(input: PostToolUseHookInput): Promise<{ ok: true }> {
    const pending = tracker.resolve(input.session_id, input.tool_name, input.tool_input);
    if (pending) {
      await mkdir(dirname(LOG_PATH), { recursive: true });
      const line =
        JSON.stringify({
          at: new Date().toISOString(),
          toolName: input.tool_name,
          toolInput: input.tool_input,
          classifierReason: pending.reason,
          executed: true,
          success: input.success ?? null,
        }) + "\n";
      await appendFile(LOG_PATH, line, "utf8");
    }
    return { ok: true };
  };
}
