import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Runtime } from "../runtime.js";
import { runTurn, type TurnEvent } from "./turn-runner.js";
import { setClaudeSessionId } from "./chats.js";

export interface RemoteSession {
  chatId: string;
  token: string;
  clients: Set<WebSocket>;
  cwd: string;
  claudeSessionId: string | null;
  startedAt: number;
  /** Non-null while a turn's `claude -p` process is running for this chat.
   * Only one turn can run at a time per chat -- there's no persistent
   * process to queue against, each turn is a fresh spawn. */
  abortController: AbortController | null;
}

/**
 * One connectable session slot per chat, shared by however many WebSocket
 * clients are attached (a phone and the desktop app can both watch/drive
 * the same chat). Unlike the old PTY model there's no persistent process
 * tied to a session -- `sendUserMessage` spawns a fresh one-shot `claude -p`
 * turn on demand and broadcasts its parsed events to every attached client.
 */
export class RemoteSessionManager {
  private sessions = new Map<string, RemoteSession>();
  private byToken = new Map<string, RemoteSession>();

  constructor(private runtime: Runtime) {}

  get(chatId: string): RemoteSession | null {
    return this.sessions.get(chatId) ?? null;
  }

  list(): RemoteSession[] {
    return [...this.sessions.values()];
  }

  isRunning(chatId: string): boolean {
    return !!this.sessions.get(chatId)?.abortController;
  }

  /** claudeSessionId, if known (from a persisted ChatRecord), lets a
   * reopened chat genuinely resume Claude Code's own conversation state
   * via `--resume` -- a real continuation, not just "same folder, fresh
   * context" like the old PTY-based reopen was. */
  start(chatId: string, cwd: string, claudeSessionId: string | null = null): RemoteSession {
    if (this.sessions.has(chatId)) {
      throw new Error("this chat already has a live session -- stop it first");
    }
    const token = randomBytes(24).toString("base64url");
    const session: RemoteSession = { chatId, token, clients: new Set(), cwd, claudeSessionId, startedAt: Date.now(), abortController: null };
    this.sessions.set(chatId, session);
    this.byToken.set(token, session);
    return session;
  }

  stop(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    session.abortController?.abort();
    for (const client of session.clients) client.close(1000, "session stopped");
    this.sessions.delete(chatId);
    this.byToken.delete(session.token);
    return true;
  }

  findByToken(token: string): RemoteSession | null {
    return this.byToken.get(token) ?? null;
  }

  broadcast(session: RemoteSession, event: TurnEvent): void {
    const payload = JSON.stringify(event);
    for (const client of session.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  async sendUserMessage(session: RemoteSession, text: string): Promise<void> {
    if (session.abortController) {
      throw new Error("a turn is already running for this chat");
    }
    const controller = new AbortController();
    session.abortController = controller;
    try {
      await runTurn(
        this.runtime,
        session.cwd,
        text,
        session.claudeSessionId ?? undefined,
        (event) => {
          if (event.type === "session") {
            session.claudeSessionId = event.sessionId;
            void setClaudeSessionId(session.chatId, event.sessionId);
          }
          this.broadcast(session, event);
        },
        controller.signal,
      );
    } finally {
      session.abortController = null;
    }
  }
}
