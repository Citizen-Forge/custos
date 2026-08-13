import { ROLE_PROMPTS } from "../prompts.js";
import type { AgentDef } from "../types.js";

/** The full persona for a run: the role's base contract, then the agent's
 * own prompt, then every tuning note the engineering manager has appended,
 * then the output contract. Order matters -- the base prompt is what the
 * orchestrator relies on, so it can't be displaced by later additions. */
export function buildSystemPrompt(agent: AgentDef, extra: string | undefined, contract?: string): string {
  const parts = [ROLE_PROMPTS[agent.role]];
  if (agent.specialty) parts.push(`## Your specialty\n\n${agent.specialty}`);
  if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim());
  if (agent.notes.length) parts.push(`## Standing instructions from your engineering manager\n\n${agent.notes.map((n) => `- ${n}`).join("\n")}`);
  if (extra?.trim()) parts.push(extra.trim());
  // Omitted entirely for tool-driven runs (see RunAgentOptions.toolDriven)
  // -- there's no closing JSON block to remind the model about, and the
  // "report your result" framing would be actively misleading alongside
  // tools that already apply each decision as it's made.
  if (contract) parts.push(contract);
  return parts.join("\n\n");
}
