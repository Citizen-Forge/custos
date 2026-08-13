import type { Runtime } from "../runtime.js";
import type { Orchestrator } from "../pm/orchestrator.js";
import { getSettings } from "../pm/project-settings.js";
import { postMessage } from "./client.js";
import { DEFAULT_PERSONA } from "./personas.js";

/** Wires the orchestrator's "activity" events to Slack, posting into
 *  whichever channel that project has configured. This is the piece that
 *  was missing entirely before -- the admin panel's Slack settings and
 *  each project's `slackChannelId` field already existed, but nothing
 *  ever called Slack's API with them.
 *
 *  Every activity line already carries its own attribution in the text
 *  (`"${agent.name} finished ..."`, etc. -- see orchestrator.ts's many
 *  `emit("activity", ...)` call sites), so this posts everything under
 *  the one DEFAULT_PERSONA rather than plumbing a role through every
 *  emit call. personas.ts's ROLE_PERSONAS stays available for a future
 *  pass that wants a distinct name/icon per role.
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

async function postActivity(runtime: Runtime, projectId: string, message: string): Promise<void> {
  const slack = runtime.config.slack;
  if (!slack?.botToken || slack.enabled === false) return;
  const settings = await getSettings(projectId);
  if (!settings.slackChannelId) return;
  const result = await postMessage(slack.botToken, settings.slackChannelId, message, DEFAULT_PERSONA);
  if (!result.ok) {
    // Not re-emitted as another "activity" event -- that would risk a
    // failing Slack post generating an infinite loop of activity events
    // about itself. A one-line console log is enough for an operator
    // grepping container logs to notice a stale token or a channel the
    // bot was removed from.
    console.error(`[slack] failed to post to ${settings.slackChannelId} for project ${projectId}: ${result.error}`);
  }
}
