import type { ProviderRouter } from "../providers/router.js";

export type ClassifierDecision = "allow" | "deny" | "ask";

const SYSTEM_PROMPT = `You gate tool calls for an autonomous coding agent (Claude Code). Given a tool name and its input, decide whether to:
- "allow": the action is safe to run without asking a human (reading, listing, non-destructive commands, routine edits within a project directory)
- "deny": the action is clearly dangerous or destructive (deleting data, force-pushing, modifying system files, exfiltrating secrets, running arbitrary network installers) and should never run
- "ask": you are not confident enough to decide either way; a human should be asked

Respond with ONLY a JSON object: {"decision": "allow" | "deny" | "ask", "reason": "one sentence"}`;

export async function classifyAction(
  router: ProviderRouter,
  toolName: string,
  toolInput: unknown,
): Promise<{ decision: ClassifierDecision; reason: string }> {
  const res = await router.complete("permissionClassifier", {
    model: "classifier",
    system: SYSTEM_PROMPT,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Tool: ${toolName}\nInput: ${JSON.stringify(toolInput)}`,
      },
    ],
  });

  const text = await new Response(res.body).text();
  let parsed: unknown;
  try {
    const json = JSON.parse(text);
    const contentText: string = json.content?.[0]?.text ?? text;
    parsed = JSON.parse(contentText.trim());
  } catch {
    return { decision: "ask", reason: "classifier response was not valid JSON" };
  }

  const { decision, reason } = parsed as { decision?: string; reason?: string };
  if (decision === "allow" || decision === "deny" || decision === "ask") {
    return { decision, reason: reason ?? "" };
  }
  return { decision: "ask", reason: "classifier returned an unrecognized decision" };
}
