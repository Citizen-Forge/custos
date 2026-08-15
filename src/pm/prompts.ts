// Every built-in role's persona, output shape, and fallback-set defaults.
// Split by concern under ./prompts/: defaults.ts (fallback-set defaults),
// role-prompts.ts (the persona text, one const per role), shapes.ts (the
// JSON output shapes outputContract() wraps). This file keeps outputContract
// itself and the ROLE_PROMPTS lookup map, and re-exports everything else so
// every existing `from "./prompts.js"` import keeps working.
import { FACTS_CONTRACT_FIELD } from "./facts.js";
import type { AgentRole } from "./types.js";
import {
  STEERING_PROMPT,
  PRODUCT_OWNER_PROMPT,
  ENGINEERING_MANAGER_PROMPT,
  ENGINEER_PROMPT,
  PRINCIPAL_PROMPT,
  QA_PROMPT,
  DEVOPS_PROMPT,
  PROJECT_MANAGER_PROMPT,
} from "./prompts/role-prompts.js";

export { ROLE_DEFAULT_FALLBACK_SET, GLOBAL_AGENT_FALLBACK_SET, ROLE_DEFAULT_MODEL } from "./prompts/defaults.js";
export {
  PORTFOLIO_PROMPT,
  STEERING_PROMPT,
  SURVEY_PROMPT,
  PRODUCT_OWNER_PROMPT,
  ENGINEERING_MANAGER_PROMPT,
  ENGINEER_PROMPT,
  PRINCIPAL_PROMPT,
  QA_PROMPT,
  DEVOPS_PROMPT,
  PROJECT_MANAGER_PROMPT,
} from "./prompts/role-prompts.js";
export { PLAN_SHAPE, QA_SHAPE, SURVEY_SHAPE, PROVISION_SHAPE, ASSIGN_MODELS_SHAPE, DEVOPS_SHAPE } from "./prompts/shapes.js";

/**
 * Every non-interactive role reports back through a single fenced block
 * with a role-specific tag. Structured output is the only channel the
 * orchestrator trusts to mutate the board: an agent can write files, run
 * commands and open PRs freely, but it cannot move a ticket or invent an
 * epic except by saying so here, which keeps the lifecycle enforceable in
 * board.ts instead of dependent on prompt compliance.
 */
export function outputContract(tag: string, shape: string): string {
  // The facts field is appended here rather than written into each shape so
  // every role gets it, and gets it worded identically -- the shared store
  // is only useful if all six roles actually write to it.
  const withFacts = shape.replace(/\n\}$/, `,\n  ${FACTS_CONTRACT_FIELD}\n}`);
  return `
## Reporting your result

End your final message with exactly one fenced block tagged \`${tag}\`, and nothing after it:

\`\`\`${tag}
${withFacts}
\`\`\`

\`facts\` is the project's shared knowledge store, readable by every agent on this project — it's how what you learned reaches whoever works here next. Write an entry when you discover something durable and cross-cutting: where the repository is, how to run the tests or the build, a convention you had to work out, a constraint that isn't written down anywhere. Use a short stable key (\`repo.url\`, \`test.command\`) and overwrite a key when you find its current value is wrong. Leave the array empty if you learned nothing that outlives your ticket — most runs do, and an invented fact is worse than no fact.

Rules for that block:
- It must be valid JSON. No comments, no trailing commas, no prose inside the fence.
- Emit it exactly once, in your final message. Anything you say before it is treated as working notes.
- If you could not complete the task, still emit the block with whatever fields you can fill and put the reason in the block's own error/notes field. A missing block is treated as a failed run.`;
}

export const ROLE_PROMPTS: Record<AgentRole, string> = {
  steering: STEERING_PROMPT,
  "product-owner": PRODUCT_OWNER_PROMPT,
  "engineering-manager": ENGINEERING_MANAGER_PROMPT,
  engineer: ENGINEER_PROMPT,
  principal: PRINCIPAL_PROMPT,
  qa: QA_PROMPT,
  devops: DEVOPS_PROMPT,
  "project-manager": PROJECT_MANAGER_PROMPT,
};
