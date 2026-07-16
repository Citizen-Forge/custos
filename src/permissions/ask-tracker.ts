interface PendingAsk {
  reason: string;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;

/** Correlates a PreToolUse "ask" verdict with a later PostToolUse firing
 * for the same call, so an outcome can be logged. Purely in-memory and
 * best-effort -- entries older than the TTL are dropped rather than kept
 * forever (a human might never answer, or Claude Code's own permission
 * system might deny it before it ever executes). */
export class AskTracker {
  private pending = new Map<string, PendingAsk>();

  private key(sessionId: string, toolName: string, toolInput: unknown): string {
    return `${sessionId}:${toolName}:${JSON.stringify(toolInput)}`;
  }

  recordAsk(sessionId: string, toolName: string, toolInput: unknown, reason: string): void {
    this.sweep();
    this.pending.set(this.key(sessionId, toolName, toolInput), { reason, at: Date.now() });
  }

  resolve(sessionId: string, toolName: string, toolInput: unknown): PendingAsk | undefined {
    const key = this.key(sessionId, toolName, toolInput);
    const entry = this.pending.get(key);
    if (entry) this.pending.delete(key);
    return entry;
  }

  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(key);
    }
  }
}
