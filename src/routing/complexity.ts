import type { AnthropicMessagesRequest, ComplexityTier } from "../types.js";
import { blockText } from "../providers/openai-translate.js";
import type { ProviderRouter } from "../providers/router.js";

const SYSTEM_PROMPT = `Classify the complexity of the LATEST user message in this coding-assistant conversation. Respond with ONLY a JSON object: {"tier": "low" | "medium" | "high"}.

- "low": simple factual questions, small well-defined edits, routine lookups -- a fast, less capable model handles these well.
- "medium": typical everyday coding tasks -- multi-step but not especially hard.
- "high": complex reasoning, architecture decisions, ambiguous or open-ended requests, or anything where a wrong answer is costly -- needs the most capable model.

When uncertain, prefer the higher tier.`;

/**
 * Only a fresh human message is worth classifying. Claude Code re-sends
 * the full conversation on every tool-loop hop within a single logical
 * request (assistant tool_use -> user tool_result -> ...); reclassifying
 * -- and potentially routing to a different model -- on every one of
 * those hops would both waste a classifier call per tool call and risk
 * swapping the model mid agentic-loop, which is far more disruptive than
 * swapping between separate human turns.
 */
export function isFreshUserTurn(request: AnthropicMessagesRequest): boolean {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user") return false;
  if (typeof last.content === "string") return true;
  return !last.content.some((block) => block.type === "tool_result");
}

export async function classifyComplexity(router: ProviderRouter, request: AnthropicMessagesRequest): Promise<ComplexityTier> {
  const last = request.messages.at(-1);
  const text = last ? (typeof last.content === "string" ? last.content : blockText(last.content)) : "";

  try {
    const res = await router.complete("complexityClassifier", {
      model: "complexity-classifier",
      system: SYSTEM_PROMPT,
      max_tokens: 50,
      messages: [{ role: "user", content: text.slice(0, 4000) }],
    });
    const responseText = await new Response(res.body).text();
    const json = JSON.parse(responseText);
    const contentText: string = json.content?.[0]?.text ?? responseText;
    const parsed = JSON.parse(contentText.trim());
    if (parsed.tier === "low" || parsed.tier === "medium" || parsed.tier === "high") return parsed.tier;
  } catch {
    // Fall through to the safe default below.
  }
  return "medium";
}
