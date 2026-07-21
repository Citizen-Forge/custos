import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const CHATS_PATH = process.env.GATEWAY_CHATS_PATH ?? "data/chats.json";

export interface ChatRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  /** Set when the user explicitly stops the session. A live PTY dying for
   * any other reason (crash, container restart) leaves this null -- the
   * chat's actual liveness is always read from RemoteSessionManager, not
   * this field, so a stale null here just means "not known to have been
   * cleanly stopped," not "still running." */
  endedAt: number | null;
}

async function readAll(): Promise<ChatRecord[]> {
  try {
    return JSON.parse(await readFile(CHATS_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(chats: ChatRecord[]): Promise<void> {
  await mkdir(dirname(CHATS_PATH), { recursive: true });
  await writeFile(CHATS_PATH, JSON.stringify(chats, null, 2), "utf8");
}

export async function listChats(projectId?: string): Promise<ChatRecord[]> {
  const chats = await readAll();
  return projectId ? chats.filter((c) => c.projectId === projectId) : chats;
}

export async function getChat(id: string): Promise<ChatRecord | null> {
  const chats = await readAll();
  return chats.find((c) => c.id === id) ?? null;
}

export async function createChat(projectId: string, title: string): Promise<ChatRecord> {
  const chats = await readAll();
  const chat: ChatRecord = { id: randomBytes(12).toString("base64url"), projectId, title, createdAt: Date.now(), endedAt: null };
  chats.push(chat);
  await writeAll(chats);
  return chat;
}

export async function renameChat(id: string, title: string): Promise<ChatRecord | null> {
  const chats = await readAll();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return null;
  chat.title = title;
  await writeAll(chats);
  return chat;
}

export async function markChatEnded(id: string): Promise<void> {
  const chats = await readAll();
  const chat = chats.find((c) => c.id === id);
  if (chat && chat.endedAt === null) {
    chat.endedAt = Date.now();
    await writeAll(chats);
  }
}

export async function markChatStarted(id: string): Promise<void> {
  const chats = await readAll();
  const chat = chats.find((c) => c.id === id);
  if (chat) {
    chat.endedAt = null;
    await writeAll(chats);
  }
}

export async function deleteChat(id: string): Promise<boolean> {
  const chats = await readAll();
  const next = chats.filter((c) => c.id !== id);
  if (next.length === chats.length) return false;
  await writeAll(next);
  return true;
}
