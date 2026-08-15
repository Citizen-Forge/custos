import type { Runtime } from "../runtime.js";
import type { Orchestrator, ActivityMessage } from "../pm/orchestrator.js";
import { getSettings } from "../pm/project-settings.js";
import { postMessage } from "./client.js";
import { DEFAULT_PERSONA, ROLE_PERSONAS, type SlackPersona } from "./personas.js";

/** Wires the orchestrator's "activity" events to Slack, posting into
 *  whichever channel that project has configured. This is the piece that
 *  was missing entirely before -- the admin panel's Slack settings and
 *  each project's `slackChannelId` field already existed, but nothing
 *  ever called Slack's API with them.
 *
 *  When an event names its acting agent (ActivityMessage.agent), this
 *  posts under THAT agent's own persona -- "Mei-Ling Chen (Principal
 *  Engineer)" with the role's icon, not the generic Custos identity --
 *  using .slackText, the first-person variant of the same event ("I
 *  finished work on X and sent it to QA" rather than the admin UI
 *  toast's third-person "Principal Engineer finished X..."). System-level
 *  events with no acting agent (budget exceeded, a stalled run, the
 *  project paused) have neither and post .text under DEFAULT_PERSONA, same
 *  as before this file could tell the two apart.
 *
 *  Fire-and-forget: a Slack outage or a bad token must never affect
 *  orchestration itself, so failures are swallowed here (nothing
 *  upstream is awaiting this).
 */
export function wireSlackActivity(orchestrator: Orchestrator, runtime: Runtime): void {
  orchestrator.on("activity", (projectId, message) => {
    void postActivity(runtime, projectId, message);
  });
}

/** Exported for testing -- the pure part of postActivity's persona choice,
 *  no network I/O. */
export function personaFor(message: ActivityMessage): SlackPersona {
  if (!message.agent) return DEFAULT_PERSONA;
  const { personaName, name, role } = message.agent;
  return {
    username: personaName ? `${personaName} (${name})` : name,
    iconEmoji: ROLE_PERSONAS[role]?.iconEmoji ?? DEFAULT_PERSONA.iconEmoji,
  };
}

async function postActivity(runtime: Runtime, projectId: string, message: ActivityMessage): Promise<void> {
  const slack = runtime.config.slack;
  if (!slack?.botToken || slack.enabled === false) return;
  const settings = await getSettings(projectId);
  if (!settings.slackChannelId) return;
  const text = message.agent ? (message.slackText ?? message.text) : message.text;
  const result = await postMessage(slack.botToken, settings.slackChannelId, text, personaFor(message));
  if (!result.ok) {
    // Not re-emitted as another "activity" event -- that would risk a
    // failing Slack post generating an infinite loop of activity events
    // about itself. A one-line console log is enough for an operator
    // grepping container logs to notice a stale token or a channel the
    // bot was removed from.
    console.error(`[slack] failed to post to ${settings.slackChannelId} for project ${projectId}: ${result.error}`);
  }
}
