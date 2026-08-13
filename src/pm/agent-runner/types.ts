import type { TurnEvent } from "../../remote/turn-runner.js";
import type { AgentDef } from "../types.js";

export interface AgentRunResult<T> {
  runId: string;
  ok: boolean;
  /** The parsed contract block, or null when the agent never emitted a
   * well-formed one -- which the orchestrator treats as a failed run
   * regardless of what the agent said in prose. */
  parsed: T | null;
  text: string;
  error: string | null;
  costUsd: number | null;
  runMs: number;
  /** True only for the two pre-spawn "nothing was even dispatched"
   *  failures below (resolveFallbackSet found the whole chain
   *  unavailable, or the pre-spawn probe couldn't reach the resolved
   *  provider) -- never set for a run that actually reached a provider
   *  and got back a bad result. The orchestrator uses this to skip
   *  per-ticket attempt backoff for these: no dispatch was attempted, no
   *  money spent, and every provider already has its own cooldown --
   *  piling a separate, coarser ticket-level backoff on top of ordinary
   *  concurrency contention (three engineers sharing one maxConcurrent:1
   *  local slot) meant a ticket could serve up to a full hour's penalty
   *  for what amounts to "someone else had the slot for a few seconds". */
  unavailable?: boolean;
}

export interface RunAgentOptions {
  agent: AgentDef;
  projectId: string;
  cwd: string;
  /** The task prompt for this specific run -- the ticket, the brief, the
   * board state. The role persona comes from the agent, not from here. */
  prompt: string;
  /** Fence tag the contract block is expected under (e.g. "custos-plan"). */
  tag: string;
  /** Appended after the role prompt and before the output contract, for
   * per-run instructions that aren't part of the persona. */
  extraSystemPrompt?: string;
  /** Omit for a tool-driven run (see toolDriven below) -- there's nothing
   * to report a result *as*, the tool calls already are the result. */
  outputContract?: string;
  /** True when this run's task prompt tells the model to act via MCP tools
   * (see mcpConfig) rather than emit one JSON block at the end. Changes
   * three things: the system prompt drops the output-contract framing
   * entirely (see buildSystemPrompt), the trailing "remember to end with
   * a fenced block" reminder is skipped, and success is judged by whether
   * the turn completed cleanly rather than by whether a parseable block
   * showed up in the transcript -- state changes already landed as each
   * tool call happened, so `parsed` is always null here; there's nothing
   * left to extract. */
  toolDriven?: boolean;
  /** Inline `--mcp-config` JSON string for this run's spawned turn -- see
   * mcp/pm-tools.ts's buildPmMcpConfig for the toolDriven case, or
   * mcp/server.ts's buildPortfolioMcpConfig for the sibling pattern used
   * by portfolio chat. */
  mcpConfig?: string;
  workItemId?: string | null;
  ideaId?: string | null;
  onEvent?: (event: TurnEvent) => void;
  /** One-line "what it's doing now", for the live activity view. */
  onProgress?: (action: string) => void;
  signal?: AbortSignal;
}
