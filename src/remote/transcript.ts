import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MessageContentBlock } from "./turn-runner.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * A past turn, normalised into the same shapes the live stream emits so the
 * UI can render history and live events with one code path.
 */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; content: MessageContentBlock[] }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean };

/**
 * Finds a session's transcript file.
 *
 * Claude Code stores these under ~/.claude/projects/<mangled-cwd>/<id>.jsonl,
 * where the directory name is the working directory with separators replaced.
 * Rather than reproduce that mangling — an undocumented detail that would
 * break silently if it changed — this scans the project directories for the
 * session id, which is stable and is what we actually have.
 */
async function findTranscriptFile(sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return null;
}

/** The handoff block is machinery the UI renders as a card, not prose. */
const HANDOFF_FENCE = /```custos-handoff[ \t]*\r?\n[\s\S]*?```/g;

/**
 * Replays a chat's history from Claude Code's own transcript.
 *
 * Custos doesn't keep its own copy of a conversation: the authoritative
 * record is the one Claude Code writes, and duplicating it would mean two
 * versions of the truth that drift. Reading it back is what makes reopening
 * a chat show what was said rather than an empty pane.
 *
 * Returns an empty list when the session has no transcript — a chat that
 * never completed a turn, or one whose transcript predates the persistent
 * ~/.claude mount and was lost to a container rebuild.
 */
export async function readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  const file = await findTranscriptFile(sessionId);
  if (!file) return [];

  const raw = await readFile(file, "utf8");
  const entries: TranscriptEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const message = parsed.message as { role?: string; content?: unknown } | undefined;
    if (!message?.role) continue;

    if (message.role === "user") {
      // A user entry is either something the human typed or the tool results
      // being fed back in. Only the former belongs in a transcript.
      if (typeof message.content === "string") {
        if (message.content.trim()) entries.push({ kind: "user", text: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const text: string[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          entries.push({
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
            isError: !!block.is_error,
          });
        } else if (block.type === "text" && typeof block.text === "string") {
          text.push(block.text);
        }
      }
      const joined = text.join("\n").trim();
      if (joined) entries.push({ kind: "user", text: joined });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content: MessageContentBlock[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          const text = block.text.replace(HANDOFF_FENCE, "").trim();
          if (text) content.push({ type: "text", text });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      if (content.length) entries.push({ kind: "assistant", content });
    }
  }

  return entries;
}
