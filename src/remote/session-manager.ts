import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Runtime } from "../runtime.js";
import { runTurn, ResumeSessionNotFoundError, type TurnEvent } from "./turn-runner.js";
import { setClaudeSessionId, type ChatKind } from "./chats.js";
import { extractContract } from "../pm/agent-runner.js";
import { createIdea } from "../pm/ideas.js";
import type { HandoffContract } from "../pm/contracts.js";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRequestEvent {
  type: "approval_request";
  id: string;
  toolName: string;
  toolInput: unknown;
  reason: string;
  /** The classifier's own verdict: "ask" (uncertain) or "deny" (flagged as
   * unsafe). Both are surfaced for a human decision since the operator is
   * present in remote control -- the UI uses this to show "deny" more
   * prominently as an override-a-block rather than a routine approval. */
  severity: "ask" | "deny";
}

export interface ApprovalResolvedEvent {
  type: "approval_resolved";
  id: string;
  decision: ApprovalDecision;
}

/** Emitted when a Steering Co turn ended with a handoff block, so the UI
 * can tell the user their idea actually landed in the roadmap inbox
 * instead of leaving them to go and check. */
export interface IdeaHandoffEvent {
  type: "idea_handoff";
  ideaId: string;
  title: string;
}

/** Anything the server pushes to a chat's WS clients: streamed turn events
 * plus out-of-band approval request/resolution frames. */
export type ServerEvent = TurnEvent | ApprovalRequestEvent | ApprovalResolvedEvent | IdeaHandoffEvent;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RemoteSession {
  chatId: string;
  projectId: string;
  /** Steering chats capture handoff blocks out of the assistant's text;
   * ordinary chats don't. */
  kind: ChatKind;
  token: string;
  clients: Set<WebSocket>;
  cwd: string;
  claudeSessionId: string | null;
  startedAt: number;
  /** Persona appended to every turn in this chat. Set for Steering Co
   * chats, which are a specific adversarial role rather than a general
   * coding session; null for ordinary chats. */
  appendSystemPrompt?: string;
  /** Pinned `custos:<provider>/<model>` alias for this chat, if it should
   * run somewhere other than the default route. */
  model?: string;
  /** Non-null while a turn's `claude -p` process is running for this chat.
   * Only one turn can run at a time per chat -- there's no persistent
   * process to queue against, each turn is a fresh spawn. */
  abortController: AbortController | null;
}

export interface StartSessionOptions {
  claudeSessionId?: string | null;
  appendSystemPrompt?: string;
  model?: string;
  kind?: ChatKind;
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
  private pendingApprovals = new Map<string, PendingApproval>();

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

  /** Finds the live session for a chat by Claude Code's own session id --
   * used to route a PreToolUse hook call (which only carries session_id and
   * cwd) back to the chat whose turn triggered it. The id is captured from
   * the turn's init event, which always precedes any tool call, so it's set
   * by the time an approval is needed. */
  findByClaudeSessionId(claudeSessionId: string): RemoteSession | null {
    for (const session of this.sessions.values()) {
      if (session.claudeSessionId === claudeSessionId) return session;
    }
    return null;
  }

  /**
   * Surfaces a permission decision to the chat's connected clients and waits
   * for a human to answer. Returns "deny" if no one is watching the chat or
   * if no answer arrives before timeoutMs -- fail closed, same posture as
   * the old auto-deny, but only after actually giving the user a chance.
   */
  requestApproval(
    session: RemoteSession,
    request: { toolName: string; toolInput: unknown; reason: string; severity: "ask" | "deny" },
    timeoutMs: number,
  ): Promise<ApprovalDecision> {
    if (session.clients.size === 0) return Promise.resolve("deny");

    const id = randomBytes(9).toString("base64url");
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve("deny");
      }, timeoutMs);
      this.pendingApprovals.set(id, { resolve, timer });
      this.broadcast(session, {
        type: "approval_request",
        id,
        toolName: request.toolName,
        toolInput: request.toolInput,
        reason: request.reason,
        severity: request.severity,
      });
    });
  }

  /** Resolves a pending approval from a client's answer. No-op if the id is
   * unknown (already answered, timed out, or from a different instance). */
  resolveApproval(id: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(id);
    pending.resolve(decision);
  }

  /** claudeSessionId, if known (from a persisted ChatRecord), lets a
   * reopened chat genuinely resume Claude Code's own conversation state
   * via `--resume` -- a real continuation, not just "same folder, fresh
   * context" like the old PTY-based reopen was. */
  start(chatId: string, projectId: string, cwd: string, options: StartSessionOptions = {}): RemoteSession {
    if (this.sessions.has(chatId)) {
      throw new Error("this chat already has a live session -- stop it first");
    }
    const token = randomBytes(24).toString("base64url");
    const session: RemoteSession = {
      chatId,
      projectId,
      kind: options.kind ?? "chat",
      token,
      clients: new Set(),
      cwd,
      claudeSessionId: options.claudeSessionId ?? null,
      startedAt: Date.now(),
      appendSystemPrompt: options.appendSystemPrompt,
      model: options.model,
      abortController: null,
    };
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

  broadcast(session: RemoteSession, event: ServerEvent): void {
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

    let assistantText = "";
    const onEvent = (event: TurnEvent): void => {
      if (event.type === "session") {
        session.claudeSessionId = event.sessionId;
        void setClaudeSessionId(session.chatId, event.sessionId);
      }
      if (session.kind === "steering" && event.type === "message_final") {
        for (const block of event.content) if (block.type === "text") assistantText += block.text + "\n";
      }
      this.broadcast(session, event);
    };

    const base = {
      cwd: session.cwd,
      prompt: text,
      appendSystemPrompt: session.appendSystemPrompt,
      model: session.model,
      onEvent,
      signal: controller.signal,
    };

    try {
      await runTurn(this.runtime, { ...base, resumeSessionId: session.claudeSessionId ?? undefined });
    } catch (err) {
      // The stored session id is stale (its transcript is gone, e.g. after a
      // container restart) -- drop it and retry once as a fresh session so
      // the user's message still lands instead of erroring out.
      if (err instanceof ResumeSessionNotFoundError && session.claudeSessionId) {
        session.claudeSessionId = null;
        await runTurn(this.runtime, base);
      } else {
        throw err;
      }
    } finally {
      session.abortController = null;
    }

    if (session.kind === "steering") await this.captureHandoff(session, assistantText);
  }

  /**
   * Steering Co is an interactive chat, not an orchestrated agent run, so a
   * handoff can't come back as a run result -- it's parsed out of what the
   * assistant said. Only the last block in a turn counts: an agent that
   * showed the user a draft of the brief before emitting the real one would
   * otherwise drop two ideas into the inbox.
   */
  private async captureHandoff(session: RemoteSession, text: string): Promise<void> {
    const parsed = extractContract<HandoffContract>(text, "custos-handoff");
    if (!parsed?.title || !parsed.brief) return;
    try {
      const idea = await createIdea(session.projectId, parsed.title, parsed.brief, session.chatId);
      this.broadcast(session, { type: "idea_handoff", ideaId: idea.id, title: idea.title });
      this.onIdeaHandoff?.(session.projectId, idea.id);
    } catch {
      // A failed handoff must not fail the turn the user just had -- the
      // conversation is the valuable part, and they can hand off again.
    }
  }

  /** Set by the server wiring so a handoff can kick the orchestrator
   * immediately instead of waiting out a poll interval. */
  onIdeaHandoff?: (projectId: string, ideaId: string) => void;
}
