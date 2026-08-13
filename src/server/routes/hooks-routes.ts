import type { FastifyInstance } from "fastify";
import { createPreToolUseHandler, type PreToolUseHookInput } from "../../permissions/hook-handler.js";
import { createPostToolUseHandler, type PostToolUseHookInput } from "../../permissions/post-tool-use-handler.js";
import { AskTracker } from "../../permissions/ask-tracker.js";
import { createUserPromptSubmitHandler, type UserPromptSubmitInput } from "../../memory/hook-handlers.js";
import type { RouteDeps } from "./types.js";

// How long a chat-mode "ask" waits for a human to click approve/deny before
// failing closed. Kept below the PreToolUse hook's own timeout (see
// headless-settings.ts) so we always return an explicit deny rather than
// letting Claude Code's hook timeout decide.
const APPROVAL_TIMEOUT_MS = 270_000;

export function registerHooksRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const askTracker = new AskTracker();
  const preToolUseHandler = createPreToolUseHandler(deps.runtime, askTracker);
  const postToolUseHandler = createPostToolUseHandler(askTracker);
  const userPromptSubmitHandler = createUserPromptSubmitHandler(deps.memoryStore, deps.runtime);

  app.post("/hooks/pretooluse", async (req) => {
    return preToolUseHandler(req.body as PreToolUseHookInput);
  });

  // Used by one-shot `claude -p` turns spawned for chat-mode chats (see
  // remote/turn-runner.ts). There's no TTY in `-p` mode for Claude Code's
  // own interactive permission prompt, so an "ask" is surfaced to the
  // chat's connected clients (the desktop app / browser transcript) as an
  // approval request instead, and this hook blocks until the human answers.
  // Falls back to deny if the chat can't be located or no one is watching
  // -- fail closed, but only after actually offering the choice.
  app.post("/hooks/pretooluse-headless", async (req) => {
    const input = req.body as PreToolUseHookInput;
    const result = await preToolUseHandler(input);
    const verdict = result.hookSpecificOutput.permissionDecision;
    const reason = result.hookSpecificOutput.permissionDecisionReason;
    // "allow" runs automatically. Both "ask" and "deny" are surfaced to the
    // operator, who is the final authority in remote control -- "deny" shown
    // as an override-a-block, "ask" as a routine approval.
    if (verdict === "allow") return result;

    const session = deps.remoteSessionManager.findByClaudeSessionId(input.session_id);
    const respond = (decision: "allow" | "deny", r: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: decision, permissionDecisionReason: r },
    });

    if (!session) {
      return respond("deny", `${reason} (auto-denied: chat session not found to ask in)`);
    }

    const decision = await deps.remoteSessionManager.requestApproval(
      session,
      { toolName: input.tool_name, toolInput: input.tool_input, reason, severity: verdict },
      APPROVAL_TIMEOUT_MS,
    );
    return decision === "allow" ? respond("allow", `approved in chat: ${reason}`) : respond("deny", `denied in chat: ${reason}`);
  });

  // Used by autonomous PM agent runs (product owner, engineer, QA, devops).
  // Nobody is attached to those, so there is no one to ask: an "ask" verdict
  // proceeds and only a hard "deny" blocks. That widening is the whole
  // reason autonomy is opt-in per project and per role in project settings
  // -- it is not the posture any human-attached chat runs under.
  app.post("/hooks/pretooluse-agent", async (req) => {
    const result = await preToolUseHandler(req.body as PreToolUseHookInput);
    const { permissionDecision, permissionDecisionReason } = result.hookSpecificOutput;
    if (permissionDecision !== "ask") return result;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason: `${permissionDecisionReason} (allowed: autonomous agent run, no operator attached to ask)`,
      },
    };
  });

  app.post("/hooks/posttooluse", async (req) => {
    return postToolUseHandler(req.body as PostToolUseHookInput);
  });

  app.post("/hooks/user-prompt-submit", async (req) => {
    return userPromptSubmitHandler(req.body as UserPromptSubmitInput);
  });
}
