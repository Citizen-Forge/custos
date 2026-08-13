import type { SlackPersona } from "./personas.js";

/** Thin wrapper over the two Slack Web API methods this integration needs.
 *  Plain `fetch()`, matching how the rest of the codebase talks to
 *  upstream HTTP APIs (provider clients, GitHub via gh CLI) rather than
 *  pulling in @slack/web-api for two endpoints. */

const SLACK_API = "https://slack.com/api";

interface SlackApiError {
  ok: false;
  error: string;
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
}

/** Posts one message to a channel under a role's display name/icon (see
 *  personas.ts) rather than the app's fixed bot identity -- requires the
 *  chat:write.customize scope; without it Slack silently ignores
 *  username/icon_emoji and posts under the app's own name instead of
 *  failing, so there's nothing here to detect that case specifically. */
export async function postMessage(botToken: string, channel: string, text: string, persona: SlackPersona): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel,
        text,
        username: persona.username,
        icon_emoji: persona.iconEmoji,
      }),
    });
    const body = (await res.json()) as { ok: true; ts: string } | SlackApiError;
    if (!body.ok) return { ok: false, error: body.error };
    return { ok: true, ts: body.ts };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Messages posted to `channel` newer than `oldestTs` (Slack's `oldest` is
 *  exclusive by default, which is exactly "everything since we last
 *  looked"), oldest-first. Requires channels:history (or groups:history
 *  for a private channel) -- a 403 here almost always means the bot
 *  hasn't been invited to the channel, or is missing that scope. Capped
 *  at 50 per call; a channel that somehow accumulates more than 50 new
 *  messages between two ~20s polls will just catch up over a few more
 *  polls rather than page through history in one call. */
export async function fetchNewMessages(botToken: string, channel: string, oldestTs: string | null): Promise<{ ok: true; messages: SlackMessage[] } | { ok: false; error: string }> {
  try {
    const url = new URL(`${SLACK_API}/conversations.history`);
    url.searchParams.set("channel", channel);
    url.searchParams.set("limit", "50");
    if (oldestTs) url.searchParams.set("oldest", oldestTs);
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    const body = (await res.json()) as { ok: true; messages: SlackMessage[] } | SlackApiError;
    if (!body.ok) return { ok: false, error: body.error };
    // Slack returns newest-first; oldest-first is the natural processing
    // order (create ideas in the order they were actually posted, and
    // advance the cursor to the true max ts regardless of order).
    return { ok: true, messages: [...body.messages].reverse() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Best-effort display name for a message's author, for idea attribution.
 *  Returns null on any failure -- a missing users:read scope or a
 *  transient error shouldn't block turning the message into an idea,
 *  it just loses the nice "posted by" line. */
export async function fetchUserName(botToken: string, userId: string): Promise<string | null> {
  try {
    const url = new URL(`${SLACK_API}/users.info`);
    url.searchParams.set("user", userId);
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    const body = (await res.json()) as { ok: true; user: { real_name?: string; name?: string } } | SlackApiError;
    if (!body.ok) return null;
    return body.user.real_name ?? body.user.name ?? null;
  } catch {
    return null;
  }
}

/** A plain, non-bot, non-subtype message -- a join/leave notice, an edit,
 *  a thread-broadcast echo, or anything from the app's own bot user is
 *  never treated as a dropped idea. */
export function isPlainHumanMessage(message: SlackMessage): boolean {
  return message.type === "message" && !message.subtype && !message.bot_id && Boolean(message.user);
}
