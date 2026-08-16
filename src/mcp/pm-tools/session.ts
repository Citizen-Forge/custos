// Per-run session lifecycle for the tool-driven PM dispatch pattern.
// Sessions are per-run, in-memory, and single-use in spirit (see
// releaseSession) -- there's nothing here that needs to survive a process
// restart, matching auth/mcp-key.ts's internal key precedent.
//
// Replaces the old design for groomBacklog/assignReady, where the model had
// to hold every decision in its head and emit one giant JSON block at the
// end of the run. Observed live on the local fallback model
// (qwen3.5:9b-q4_K_M): three rounds of increasingly forceful prompt
// engineering ("you have no tools", "no prose", "OUTPUT ONLY THE BLOCK")
// still failed intermittently -- the model would produce good reasoning, or
// a generic chat greeting, or narrate its intent, and never reliably reach
// the closing fence. Tool-calling is a much more heavily-trained model
// capability than "remember to end with formatted JSON eventually", and
// each call lands immediately rather than depending on the model holding
// together a single well-formed blob for the whole run -- there's no
// "ran out of length before reaching the block" failure mode left, because
// there's no block.
import { randomBytes } from "node:crypto";

const PORT = process.env.PORT ?? "8787";

const SESSION_TTL_MS = 45 * 60_000; // matches RUN_TIMEOUT_MS's ceiling with headroom

interface BaseSession {
  token: string;
  projectId: string;
  agentId: string;
  agentName: string;
  expiresAt: number;
  /** Human-readable lines describing each successful tool call, folded
   *  into one activity-log line after the run instead of many small ones. */
  actions: string[];
}

export interface GroomSession extends BaseSession {
  kind: "groom";
  validTicketIds: Set<string>;
}

export interface CurateSession extends BaseSession {
  kind: "curate";
  validPendingIds: Set<string>;
}

export interface AssignSession extends BaseSession {
  kind: "assign";
  validTicketIds: Set<string>;
  fallbackSetNames: Set<string>;
  knownAgentIds: Set<string>;
  /** Fallback set NAMES whose resolved primary pick is currently exhausted
   *  (rate-limited, cooling, at capacity) -- precomputed by the caller
   *  against the live GatewayConfig + model-registry availability, since
   *  this module deliberately doesn't import runtime.ts. Checked against
   *  an agent's `fallbackSet` field directly, which works uniformly for
   *  both existing roster agents and ones create_engineer just made in
   *  this same run (both are assigned a set name from the same menu). */
  unavailableFallbackSets: Set<string>;
  /** Decremented on every successful assign_ticket call; assign_ticket
   *  rejects once this hits zero. Mirrors the old `slots` counter that
   *  used to gate the parsed-JSON `assignments` loop. */
  slotsRemaining: number;
}

/** What report_ready_for_qa/report_blocked capture, read back by
 *  orchestrator.ts's runEngineer once the run completes. Shaped like the
 *  old `custos-engineer` fenced JSON block this replaces, but there's
 *  nothing left to parse out of the transcript -- the tool call itself
 *  is the result. */
export type EngineerOutcome =
  | { status: "ready_for_qa"; summary: string; branch: string | null; prUrl: string | null; subtasks: Array<{ title: string; done: boolean }>; followUps: string[] }
  | { status: "blocked"; reason: string; followUps: string[] };

export interface EngineerSession extends BaseSession {
  kind: "engineer";
  workItemId: string;
  /** Null until report_ready_for_qa or report_blocked is called. Whichever
   *  is called LAST wins if the model somehow calls both in one run --
   *  no reason to crash over a model being confused rather than just
   *  taking its most recent word for it. */
  outcome: EngineerOutcome | null;
}

/** What report_qa_verdict captures, read back by orchestrator.ts's runQa
 *  once the run completes. Shaped like the old `custos-qa` fenced JSON
 *  block this replaces -- same fields, but there's nothing left to parse
 *  out of the transcript, the tool call itself is the result. prComments
 *  mirrors what the agent already posted live via `gh pr comment`
 *  (Bash is still in its toolkit -- see tool-policy.ts's DISALLOWED_TOOLS_BY_TAG
 *  entry for "custos-qa"), kept here purely so the ticket detail UI can
 *  show them without a second GitHub round-trip. */
export type QaOutcome = {
  verdict: "pass" | "fail";
  summary: string;
  criteriaChecked: Array<{ criterion: string; result: "pass" | "fail"; evidence: string }>;
  prComments: string[];
  followUps: string[];
};

export interface QaSession extends BaseSession {
  kind: "qa";
  workItemId: string;
  /** Null until report_qa_verdict is called. Last call wins, same
   *  reasoning as EngineerSession.outcome. */
  outcome: QaOutcome | null;
}

export type PmSession = GroomSession | AssignSession | CurateSession | EngineerSession | QaSession;

const sessions = new Map<string, PmSession>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}

function newToken(): string {
  return `custos_pm_${randomBytes(24).toString("base64url")}`;
}

export function mintGroomSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validTicketIds: Set<string>;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "groom", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

export function mintAssignSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validTicketIds: Set<string>;
  fallbackSetNames: Set<string>;
  knownAgentIds: Set<string>;
  unavailableFallbackSets: Set<string>;
  slotsRemaining: number;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "assign", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

export function mintCurateSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  validPendingIds: Set<string>;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "curate", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], ...input });
  return token;
}

export function mintEngineerSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  workItemId: string;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "engineer", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], outcome: null, ...input });
  return token;
}

export function mintQaSession(input: {
  projectId: string;
  agentId: string;
  agentName: string;
  workItemId: string;
}): string {
  sweepExpired();
  const token = newToken();
  sessions.set(token, { kind: "qa", token, expiresAt: Date.now() + SESSION_TTL_MS, actions: [], outcome: null, ...input });
  return token;
}

/** Returns the accumulated action log and forgets the session. Call once
 *  the run has finished (succeeded, failed, or timed out) -- a session left
 *  around after that point can't be reached by anything except a stale
 *  spawned process, and expiry would eventually clean it up anyway, but
 *  releasing promptly keeps the map from growing with every tick. */
export function releaseSession(token: string): string[] {
  const session = sessions.get(token);
  sessions.delete(token);
  return session?.actions ?? [];
}

/** Looks up a session by its bearer token without consuming it -- the route
 *  handler uses this to decide which tool set to serve (groom vs assign);
 *  the session itself is only released once, explicitly, after the run. */
export function lookupSession(token: string): PmSession | null {
  sweepExpired();
  return sessions.get(token) ?? null;
}

/** The `--mcp-config` inline JSON a groomBacklog/assignReady run's spawned
 *  turn gets, scoped to exactly this one run via the token -- see
 *  buildPortfolioMcpConfig for the sibling pattern (same shape, different
 *  endpoint and a per-run token instead of the process-lifetime one). */
export function buildPmMcpConfig(token: string): string {
  return JSON.stringify({
    mcpServers: {
      custos_pm: {
        type: "http",
        url: `http://localhost:${PORT}/mcp/pm-run`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}
