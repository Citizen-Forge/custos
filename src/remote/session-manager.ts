import * as pty from "node-pty";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

const WORKSPACE_DIR = process.env.CUSTOS_WORKSPACE_DIR ?? "/workspace";
const PORT = process.env.PORT ?? "8787";

export interface RemoteSession {
  token: string;
  proc: pty.IPty;
  clients: Set<WebSocket>;
  startedAt: number;
  cwd: string;
}

/**
 * Single active PTY-hosted `claude` session at a time (matches Remote
 * Control's own "session mode" -- simpler than juggling concurrent
 * sessions for a v1). Multiple WebSocket clients can attach to the one
 * session and all see the same output; any of them can type into it.
 */
export class RemoteSessionManager {
  private session: RemoteSession | null = null;

  get current(): RemoteSession | null {
    return this.session;
  }

  /** initialPrompt, if given, is passed as a positional CLI argument --
   * Claude Code's normal `claude "some prompt"` usage, which starts an
   * interactive session and submits that text as the first turn. Used to
   * prime a fresh session with a resume summary (see memory/conversations.ts)
   * without needing a shell (node-pty spawns with an argv array, so no
   * escaping/injection concern even though this text is LLM-generated). */
  start(cwd = WORKSPACE_DIR, initialPrompt?: string): RemoteSession {
    if (this.session) {
      throw new Error("a remote session is already active -- stop it first");
    }

    // Recursive by design: the spawned CLI's own traffic goes back through
    // Custos itself, so a remote-controlled session gets the same
    // permission gating, memory, and multi-provider routing as any other
    // Custos-fronted Claude Code session.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`;

    const proc = pty.spawn("claude", initialPrompt ? [initialPrompt] : [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const token = randomBytes(24).toString("base64url");
    const session: RemoteSession = { token, proc, clients: new Set(), startedAt: Date.now(), cwd };

    proc.onExit(() => {
      if (this.session === session) {
        for (const client of session.clients) client.close(1000, "session ended");
        this.session = null;
      }
    });

    this.session = session;
    return session;
  }

  stop(): void {
    if (!this.session) return;
    for (const client of this.session.clients) client.close(1000, "session stopped");
    this.session.proc.kill();
    this.session = null;
  }

  findByToken(token: string): RemoteSession | null {
    return this.session && this.session.token === token ? this.session : null;
  }
}
