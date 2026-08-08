import type { AgentRole } from "../pm/types.js";

/** One Slack identity per role, not per individual agent instance --
 *  confirmed as the intended scope rather than a distinct persona for
 *  every engineer/product-owner across every project. Posted via
 *  chat.postMessage's per-message `username`/`icon_emoji` override (see
 *  client.ts), so this is purely display data -- no Slack-side identity,
 *  login, or bot user is created per role. */
export interface SlackPersona {
  username: string;
  iconEmoji: string;
}

export const ROLE_PERSONAS: Record<AgentRole, SlackPersona> = {
  "project-manager": { username: "Project Manager", iconEmoji: ":clipboard:" },
  "product-owner": { username: "Product Owner", iconEmoji: ":bulb:" },
  "engineering-manager": { username: "Engineering Manager", iconEmoji: ":construction_worker:" },
  engineer: { username: "Engineer", iconEmoji: ":hammer_and_wrench:" },
  qa: { username: "QA", iconEmoji: ":mag:" },
  devops: { username: "DevOps", iconEmoji: ":rocket:" },
  steering: { username: "Steering", iconEmoji: ":compass:" },
};

/** Fallback for a message with no clear role attribution (e.g. a raw
 *  activity-log line that isn't tagged to one of the roles above). */
export const DEFAULT_PERSONA: SlackPersona = { username: "Custos", iconEmoji: ":robot_face:" };

export function personaFor(role: AgentRole | string | undefined | null): SlackPersona {
  if (!role) return DEFAULT_PERSONA;
  return ROLE_PERSONAS[role as AgentRole] ?? DEFAULT_PERSONA;
}
