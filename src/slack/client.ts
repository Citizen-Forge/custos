import type { SlackPersona } from "./personas.js";

/** Thin wrapper over the handful of Slack Web API methods this integration
 *  needs. Plain `fetch()`, matching how the rest of the codebase talks to
 *  upstream HTTP APIs (provider clients, GitHub via gh CLI) rather than
 *  pulling in @slack/web-api for a handful of endpoints. */

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
export async function postMessage(botToken: string, channel: string, text: string, persona: SlackPersona, threadTs?: string): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
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
        ...(threadTs ? { thread_ts: threadTs } : {}),
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

/** The bot's own user id (the `U...`/`B...` Slack substitutes into
 *  `<@ID>` when someone @-mentions it), resolved once per token via
 *  auth.test and cached -- needs no extra scope beyond what every bot
 *  token already has. Cached by token string, not just once globally, so
 *  rotating the token in the admin panel picks up the new identity
 *  instead of serving a stale one from before the rotation. */
const botUserIdCache = new Map<string, string | null>();

export async function resolveBotUserId(botToken: string): Promise<string | null> {
  const cached = botUserIdCache.get(botToken);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, { method: "POST", headers: { authorization: `Bearer ${botToken}` } });
    const body = (await res.json()) as { ok: true; user_id: string } | SlackApiError;
    const userId = body.ok ? body.user_id : null;
    botUserIdCache.set(botToken, userId);
    return userId;
  } catch {
    // Deliberately not cached -- a transient network error shouldn't
    // stick a project with "mentions never work" until the next restart.
    return null;
  }
}

/** Slack renders an @-mention in message text as the literal substring
 *  `<@U12345>` (or `<@U12345|displayname>` in some clients) -- this is a
 *  plain string check, not markdown to parse. Returns the message with
 *  the mention (and any leading/trailing whitespace it leaves behind)
 *  stripped, so "<@U0BOT> what's in progress?" becomes "what's in
 *  progress?" for whatever reads the question back out. */
export function stripBotMention(text: string, botUserId: string): { mentioned: boolean; text: string } {
  const pattern = new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g");
  if (!pattern.test(text)) return { mentioned: false, text };
  return { mentioned: true, text: text.replace(pattern, "").trim() };
}
