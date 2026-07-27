import { randomUUID } from "node:crypto";
import type { OAuthFlow } from "./oauth.js";

interface StoredFlow {
  flow: OAuthFlow;
  at: number;
}

const FLOW_TTL_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Holds in-flight admin-UI OAuth flows (PKCE verifier + state) between
 * "start" and "complete" -- the redirect_uri is Anthropic's own page, not
 * ours, so the flow can't round-trip through a callback; the admin UI
 * polls back with a flowId and the code the user pastes in instead.
 *
 * Stale entries are purged after FLOW_TTL_MS (15 minutes) via three paths:
 *   - on every create() call
 *   - on every consume() call
 *   - a periodic timer at SWEEP_INTERVAL_MS (5 minutes)
 * This prevents abandoned OAuth flows from leaking memory. */
export class OAuthFlowTracker {
  private flows = new Map<string, StoredFlow>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Release the periodic timer. Call when the owning server shuts down so
   * the interval doesn't keep the event loop live. */
  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  create(flow: OAuthFlow): string {
    this.sweep();
    const id = randomUUID();
    this.flows.set(id, { flow, at: Date.now() });
    return id;
  }

  consume(id: string): OAuthFlow | undefined {
    this.sweep();
    const entry = this.flows.get(id);
    if (entry) this.flows.delete(id);
    return entry?.flow;
  }

  private sweep(): void {
    const cutoff = Date.now() - FLOW_TTL_MS;
    for (const [id, entry] of this.flows) {
      if (entry.at < cutoff) this.flows.delete(id);
    }
  }
}
