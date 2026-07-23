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
  let contentText = text;
  try {
    // Unwrap the Anthropic response envelope to get the model's text; if
    // that shape isn't present (some providers/paths), fall back to the raw
    // body and let extractDecision try to find JSON in it directly.
    const json = JSON.parse(text);
    contentText = json.content?.[0]?.text ?? text;
  } catch {
    // Not an envelope -- treat the whole body as the model's text.
  }

  const parsed = extractDecision(contentText);
  if (!parsed) {
    return { decision: "ask", reason: "classifier response was not valid JSON" };
  }
  if (parsed.decision === "allow" || parsed.decision === "deny" || parsed.decision === "ask") {
    return { decision: parsed.decision, reason: parsed.reason ?? "" };
  }
  return { decision: "ask", reason: "classifier returned an unrecognized decision" };
}

/** Small models often wrap the JSON in ```json fences or add a sentence
 * before/after it. Try a clean parse first, then strip fences, then fall
 * back to grabbing the first {...} object anywhere in the text. */
function extractDecision(raw: string): { decision?: string; reason?: string } | null {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  attempts.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());

  const firstObject = trimmed.match(/\{[\s\S]*\}/);
  if (firstObject) attempts.push(firstObject[0]);

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate) as { decision?: string; reason?: string };
      if (obj && typeof obj === "object" && "decision" in obj) return obj;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
