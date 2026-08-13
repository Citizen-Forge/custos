// Inbound half of the Slack integration -- the outbound half (posting
// activity lines) lives in slack/activity.ts, wired up independently in
// index.ts. This module only turns new channel messages into either an
// inbox idea or a status reply.
import * as ideas from "../ideas.js";
import { getProject } from "../../remote/projects.js";
import { getSettings, updateSettings } from "../project-settings.js";
import { fetchNewMessages, fetchUserName, isPlainHumanMessage, postMessage, resolveBotUserId, stripBotMention } from "../../slack/client.js";
import { buildStatusReply } from "../../slack/status.js";
import { DEFAULT_PERSONA } from "../../slack/personas.js";
import type { Orchestrator } from "../orchestrator.js";

/** Turns new messages in the project's configured Slack channel into
 *  inbox ideas -- the inbound half of the Slack integration (see
 *  slack/activity.ts for the outbound half). Every plain human message
 *  becomes one idea, EXCEPT a message that @-mentions the bot: that
 *  gets an immediate deterministic status reply in-thread instead (see
 *  slack/status.ts) -- "@custos what's in progress?" answers from board
 *  state directly rather than becoming something for the product owner
 *  to plan. No special syntax otherwise; the channel itself is the idea
 *  inbox. Guarded like every other dispatch so an overlapping tick
 *  can't double-poll, though a single HTTP call finishing well within
 *  one tick makes that vanishingly unlikely. */
export async function pollSlackIdeas(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`slack-poll:${projectId}`, projectId, async () => {
    const slack = orch.runtime.config.slack;
    if (!slack?.botToken || slack.enabled === false) return;
    const settings = await getSettings(projectId);
    if (!settings.slackChannelId) return;

    // First poll after a channel is configured: seed the cursor at
    // "now" instead of importing the channel's entire history as
    // ideas. Every poll after that passes the real cursor.
    if (settings.slackLastSeenTs === null) {
      await updateSettings(projectId, { slackLastSeenTs: `${Date.now() / 1000}` });
      return;
    }

    const result = await fetchNewMessages(slack.botToken, settings.slackChannelId, settings.slackLastSeenTs);
    if (!result.ok) {
      console.error(`[slack] failed to poll #${settings.slackChannelId} for project ${projectId}: ${result.error}`);
      return;
    }
    if (!result.messages.length) return;

    const botUserId = await resolveBotUserId(slack.botToken);
    let ideaCreated = false;
    let maxTs = settings.slackLastSeenTs;
    for (const message of result.messages) {
      if (Number(message.ts) > Number(maxTs)) maxTs = message.ts;
      if (!isPlainHumanMessage(message)) continue;

      // "@bot what's in progress?" gets an immediate, deterministic
      // status reply in-thread instead of becoming an idea to plan --
      // see slack/status.ts's doc comment for why this stays a board
      // query rather than a real agent dispatch. Anything that doesn't
      // @-mention the bot is a dropped idea, same as before.
      const mention = botUserId ? stripBotMention(message.text, botUserId) : { mentioned: false, text: message.text };
      if (mention.mentioned) {
        const project = await getProject(projectId);
        if (project) {
          const reply = await buildStatusReply(projectId, project.name);
          const posted = await postMessage(slack.botToken, settings.slackChannelId, reply, DEFAULT_PERSONA, message.ts);
          if (!posted.ok) console.error(`[slack] failed to post status reply for project ${projectId}: ${posted.error}`);
        }
        continue;
      }

      const author = message.user ? await fetchUserName(slack.botToken, message.user) : null;
      const title = message.text.trim().slice(0, 80) || "Idea from Slack";
      const brief = `${message.text.trim()}\n\n_Posted in Slack${author ? ` by ${author}` : ""}._`;
      await ideas.createIdea(projectId, title, brief, null);
      ideaCreated = true;
    }
    await updateSettings(projectId, { slackLastSeenTs: maxTs });
    if (ideaCreated) orch.emit("change", projectId);
  });
}
