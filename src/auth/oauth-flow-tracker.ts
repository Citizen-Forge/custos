import { randomUUID } from "node:crypto";
import type { OAuthFlow } from "./oauth.js";

interface StoredFlow {
  flow: OAuthFlow;
  at: number;
}

const FLOW_TTL_MS = 10 * 60_000;

/** Holds in-flight admin-UI OAuth flows (PKCE verifier + state) between
 * "start" and "complete" -- the redirect_uri is Anthropic's own page, not
 * ours, so the flow can't round-trip through a callback; the admin UI
 * polls back with a flowId and the code the user pastes in instead. */
export class OAuthFlowTracker {
  private flows = new Map<string, StoredFlow>();

  create(flow: OAuthFlow): string {
    this.sweep();
    const id = randomUUID();
    this.flows.set(id, { flow, at: Date.now() });
    return id;
  }

  consume(id: string): OAuthFlow | undefined {
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
