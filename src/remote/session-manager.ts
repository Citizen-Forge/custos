import * as pty from "node-pty";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { syncSpawnedSessionCredentials } from "../auth/credentials.js";
import type { Runtime } from "../runtime.js";

const PORT = process.env.PORT ?? "8787";

export interface RemoteSession {
  chatId: string;
  token: string;
  proc: pty.IPty;
  clients: Set<WebSocket>;
  startedAt: number;
  cwd: string;
}

/**
 * One live PTY-hosted `claude` process per chat, all running concurrently
 * -- chats across one or more projects can be active at the same time,
 * matching how VS Code lets several Claude Code sessions run side by side
 * in different tabs. Multiple WebSocket clients can attach to the same
 * chat's session and all see the same output; any of them can type into it.
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

  /** initialPrompt, if given, is passed as a positional CLI argument --
   * Claude Code's normal `claude "some prompt"` usage, which starts an
   * interactive session and submits that text as the first turn. Used to
   * prime a fresh session with a resume summary (see memory/conversations.ts)
   * without needing a shell (node-pty spawns with an argv array, so no
   * escaping/injection concern even though this text is LLM-generated). */
  async start(chatId: string, cwd: string, initialPrompt?: string): Promise<RemoteSession> {
    if (this.sessions.has(chatId)) {
      throw new Error("this chat already has a live session -- stop it first");
    }

    // So the spawned CLI opens already authenticated instead of hitting its
    // own /login -- projects Custos's own connected OAuth session into
    // ~/.claude/.credentials.json, the file the real CLI reads. No-op if
    // Custos hasn't connected its own OAuth (see syncSpawnedSessionCredentials).
    await syncSpawnedSessionCredentials();

    // Recursive by design: the spawned CLI's own traffic goes back through
    // Custos itself, so a remote-controlled session gets the same
    // permission gating, memory, and multi-provider routing as any other
    // Custos-fronted Claude Code session.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`;
    // The spawned CLI's own requests hit Custos's client-auth-guard just
    // like any other Claude Code install pointed at this proxy -- without
    // this they'd get 401'd the moment a client API key is configured.
    if (this.runtime.config.clientApiKey) {
      env.ANTHROPIC_API_KEY = this.runtime.config.clientApiKey;
    }

    const proc = pty.spawn("claude", initialPrompt ? [initialPrompt] : [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const token = randomBytes(24).toString("base64url");
    const session: RemoteSession = { chatId, token, proc, clients: new Set(), startedAt: Date.now(), cwd };

    proc.onExit(() => {
      for (const client of session.clients) client.close(1000, "session ended");
      this.sessions.delete(chatId);
      this.byToken.delete(token);
    });

    this.sessions.set(chatId, session);
    this.byToken.set(token, session);
    return session;
  }

  stop(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    for (const client of session.clients) client.close(1000, "session stopped");
    session.proc.kill();
    this.sessions.delete(chatId);
    this.byToken.delete(session.token);
    return true;
  }

  findByToken(token: string): RemoteSession | null {
    return this.byToken.get(token) ?? null;
  }
}
