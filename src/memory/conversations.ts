import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.js";
import { blockText } from "../providers/openai-translate.js";
import type { ProviderRouter } from "../providers/router.js";

const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
const MAX_FILES_SCANNED = 14; // ~2 weeks of daily logs

interface LoggedExchange {
  at: string;
  request: AnthropicMessagesRequest;
  response: AnthropicMessagesResponse;
}

interface ConversationGroup {
  id: string;
  startedAt: string;
  lastActiveAt: string;
  preview: string;
  exchangeCount: number;
  lastExchange: LoggedExchange;
}

export interface ConversationListEntry {
  id: string;
  startedAt: string;
  lastActiveAt: string;
  preview: string;
  exchangeCount: number;
}

function firstUserText(request: AnthropicMessagesRequest): string {
  const first = request.messages[0];
  if (!first) return "";
  const text = typeof first.content === "string" ? first.content : blockText(first.content);
  return text.slice(0, 200);
}

async function readDayFile(file: string): Promise<LoggedExchange[]> {
  const content = await readFile(join(SESSIONS_DIR, file), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LoggedExchange;
      } catch {
        return null;
      }
    })
    .filter((x): x is LoggedExchange => x !== null);
}

/**
 * Groups a day's raw exchange log into distinct conversations. There's no
 * real conversation id anywhere in the Messages API traffic itself (see
 * README limitations), but Claude Code resends the full, monotonically
 * growing message history on every call within one conversation -- so a
 * change in the first message signals a new conversation started. Good
 * enough to build a "recent conversations" picker from, not a guarantee.
 */
function groupIntoConversations(file: string, exchanges: LoggedExchange[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let current: LoggedExchange[] = [];
  let currentFirstText = "";

  const flush = () => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    groups.push({
      id: `${file}#${groups.length}`,
      startedAt: current[0].at,
      lastActiveAt: last.at,
      preview: firstUserText(current[0].request),
      exchangeCount: current.length,
      lastExchange: last,
    });
    current = [];
  };

  for (const exchange of exchanges) {
    const text = firstUserText(exchange.request);
    if (current.length > 0 && text !== currentFirstText) flush();
    if (current.length === 0) currentFirstText = text;
    current.push(exchange);
  }
  flush();

  return groups;
}

async function scanRecentConversations(): Promise<ConversationGroup[]> {
  let files: string[];
  try {
    files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const groups: ConversationGroup[] = [];
  for (const file of files.slice(0, MAX_FILES_SCANNED)) {
    groups.push(...groupIntoConversations(file, await readDayFile(file)));
  }
  return groups.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
}

export async function listConversations(limit = 20): Promise<ConversationListEntry[]> {
  const groups = await scanRecentConversations();
  return groups.slice(0, limit).map(({ lastExchange: _lastExchange, ...rest }) => rest);
}

const SUMMARY_SYSTEM_PROMPT = `Summarize this coding-assistant conversation in 3-5 sentences for someone about to resume it in a fresh session. Cover: what the goal/task was, key decisions made, and where it left off. Be concrete (mention actual file names, function names, or decisions if present) rather than vague. Respond with ONLY the summary text, no preamble.`;

/** Builds a short summary of a past conversation via the memoryCurator
 * task, for priming a fresh remote-control session -- not a literal replay
 * of the conversation (see README: that would mean reverse-engineering
 * Claude Code's own internal transcript format), just enough context for
 * Claude to pick the thread back up sensibly. */
export async function buildResumeSummary(router: ProviderRouter, conversationId: string): Promise<string | null> {
  const groups = await scanRecentConversations();
  const group = groups.find((g) => g.id === conversationId);
  if (!group) return null;

  const transcript = group.lastExchange.request.messages
    .map((m) => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : blockText(m.content)}`)
    .concat(`ASSISTANT: ${blockText(group.lastExchange.response.content)}`)
    .join("\n\n")
    .slice(0, 12_000);

  const res = await router.complete("memoryCurator", {
    model: "resume-summarizer",
    system: SUMMARY_SYSTEM_PROMPT,
    max_tokens: 300,
    messages: [{ role: "user", content: transcript }],
  });
  const responseText = await new Response(res.body).text();
  try {
    const json = JSON.parse(responseText);
    return (json.content?.[0]?.text as string | undefined) ?? null;
  } catch {
    return null;
  }
}
