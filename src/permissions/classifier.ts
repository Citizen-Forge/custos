import type { ProviderRouter } from "../providers/router.js";
import { getGlobalAgent } from "../pm/global-agents.js";

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
  // The classifier's model/provider choice is owned by the global agent
  // with systemRole === "permissionClassifier" — the same hookup the
  // memory curator uses. Going through router.completeWithEntries
  // (instead of bypassing it with a bare provider call) keeps the
  // classifier on the same throttle/cooldown surface as chat traffic,
  // so a saturated Ollama-flit instance queues classifier requests
  // rather than starving them.
  const agent = await getGlobalAgent("permissionClassifier");
  if (!agent) {
    // Bounded approximation of "ask, but explain why we had to" — when
    // the user hasn't configured a classifier, every tool call becomes
    // an in-chat approval request, which is the same fail-closed posture
    // a misconfigured classifier already gets when its response can't
    // be parsed (see extractDecision below).
    return { decision: "ask", reason: "no global agent with systemRole \"permissionClassifier\" is configured" };
  }
  const res = await router.completeWithEntries(
    [{ provider: agent.providerKey, priority: 1 }],
    {
      model: agent.model,
      system: SYSTEM_PROMPT,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Tool: ${toolName}\nInput: ${JSON.stringify(toolInput)}`,
        },
      ],
    },
    { priority: "interactive" },
    `global agent "${agent.name}" (permissionClassifier)`,
    "permissionClassifier",
  );

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
