import type { Runtime } from "../runtime.js";
import { runTurn, type TurnEvent } from "../remote/turn-runner.js";
import { formatModelAlias } from "../providers/model-alias.js";
import { ROLE_PROMPTS } from "./prompts.js";
import { resolveAgentEnv, redactSecrets } from "./vault.js";
import * as runs from "./runs.js";
import * as agents from "./agents.js";
import { RUN_TIMEOUT_MS, type AgentDef } from "./types.js";

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
  outputContract: string;
  workItemId?: string | null;
  ideaId?: string | null;
  onEvent?: (event: TurnEvent) => void;
  /** One-line "what it's doing now", for the live activity view. */
  onProgress?: (action: string) => void;
  signal?: AbortSignal;
}

/** A short human-readable line for what just happened, used both as the
 * run's `currentAction` and as the live feed's event text. Returns null for
 * events not worth showing (token deltas). */
function describeEvent(event: TurnEvent): string | null {
  if (event.type === "message_final") {
    const tool = event.content.find((block) => block.type === "tool_use");
    if (tool && tool.type === "tool_use") {
      const input = tool.input as Record<string, unknown> | undefined;
      const primary = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url;
      return typeof primary === "string" ? `${tool.name}: ${primary}` : tool.name;
    }
    const text = event.content.find((block) => block.type === "text");
    return text && text.type === "text" && text.text.trim() ? text.text.trim().split("\n")[0].slice(0, 160) : null;
  }
  if (event.type === "tool_result" && event.isError) return "a tool call failed";
  if (event.type === "error") return `error: ${event.message.slice(0, 160)}`;
  return null;
}

/**
 * Extracts the agent's contract block. Prefers the requested tag, then a
 * generic json fence, then a bare brace-balanced object -- models are
 * reliable about emitting the JSON and much less reliable about labelling
 * the fence, and a run that did all the work is too expensive to throw away
 * over a missing tag. Takes the *last* match: an agent that reasons out
 * loud often shows a draft of the block before its real one.
 */
export function extractContract<T>(text: string, tag: string): T | null {
  const candidates: string[] = [];
  const fenced = new RegExp("```(?:" + tag + "|json)?[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");
  for (const match of text.matchAll(fenced)) candidates.push(match[1]);

  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      // Try the next-most-recent fence.
    }
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** The full persona for a run: the role's base contract, then the agent's
 * own prompt, then every tuning note the engineering manager has appended,
 * then the output contract. Order matters -- the base prompt is what the
 * orchestrator relies on, so it can't be displaced by later additions. */
export function buildSystemPrompt(agent: AgentDef, extra: string | undefined, contract: string): string {
  const parts = [ROLE_PROMPTS[agent.role]];
  if (agent.specialty) parts.push(`## Your specialty\n\n${agent.specialty}`);
  if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim());
  if (agent.notes.length) parts.push(`## Standing instructions from your engineering manager\n\n${agent.notes.map((n) => `- ${n}`).join("\n")}`);
  if (extra?.trim()) parts.push(extra.trim());
  parts.push(contract);
  return parts.join("\n\n");
}

/**
 * Runs one autonomous agent to completion and returns its parsed contract.
 * Logs the run for the activity feed, folds cost and timing back into the
 * agent's stats (which is what the engineering manager's feedback loop
 * later reads), and never throws for an agent-side failure -- a failed run
 * comes back as ok:false so the orchestrator can decide what to do with the
 * ticket rather than having an exception unwind the whole tick.
 */
export async function runAgent<T>(runtime: Runtime, options: RunAgentOptions): Promise<AgentRunResult<T>> {
  const { agent, projectId, cwd, prompt, tag } = options;
  // Whether this run's reported cost is real money is decided here, from
  // the same config the engineering manager was shown when it picked the
  // provider -- see agents.listProviderOptions.
  const billed = !agents.listProviderOptions(runtime.config).find((o) => o.providerKey === agent.providerKey && o.model === agent.model)?.free;
  const run = await runs.startRun({
    projectId,
    agentId: agent.id,
    role: agent.role,
    providerKey: agent.providerKey,
    model: agent.model,
    billed,
    workItemId: options.workItemId,
    ideaId: options.ideaId,
  });
  const startedAt = Date.now();

  let text = "";
  let costUsd: number | null = null;
  let turnError: string | null = null;

  const onEvent = (event: TurnEvent): void => {
    if (event.type === "session") void runs.setRunSession(run.id, event.sessionId);

    // Heartbeat. Every event counts, so "has this done anything lately" is
    // measured from what the agent actually did rather than from asking it
    // -- the agent least able to notice it's stuck is a stuck one.
    const action = describeEvent(event);
    void runs.recordActivity(run.id, action, event.type === "message_final" && event.content.some((b) => b.type === "tool_use"));
    if (action) options.onProgress?.(action);

    // message_final replaces rather than appends within a message, but an
    // agent run is many messages; concatenating each message's final text
    // gives the whole transcript of what it said, which is where the
    // contract block lives.
    if (event.type === "message_final") {
      for (const block of event.content) if (block.type === "text") text += block.text + "\n";
    }
    if (event.type === "turn_complete") {
      if (event.costUsd !== undefined) costUsd = event.costUsd;
      if (event.resultText) text += event.resultText + "\n";
      if (event.isError) turnError = event.resultText || "the agent run ended in an error";
    }
    if (event.type === "error") turnError = event.message;
    options.onEvent?.(event);
  };

  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  // Whatever an agent past this point is doing, it isn't converging, and
  // it's still spending. Failing it returns the ticket to the orchestrator,
  // which backs off and retries rather than leaving a dead run holding a
  // concurrency slot forever.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RUN_TIMEOUT_MS);

  try {
    await runTurn(runtime, {
      cwd,
      prompt,
      appendSystemPrompt: buildSystemPrompt(agent, options.extraSystemPrompt, options.outputContract),
      model: formatModelAlias(agent.providerKey, agent.model),
      env: await resolveAgentEnv(projectId),
      hookProfile: "agent",
      onEvent,
      signal: controller.signal,
    });
  } catch (err) {
    turnError = (err as Error).message;
  } finally {
    clearTimeout(deadline);
  }

  const runMs = Date.now() - startedAt;
  const parsed = extractContract<T>(text, tag);
  if (timedOut) turnError = `the run was aborted after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes without finishing`;
  const error = turnError ?? (parsed ? null : `the agent did not return a valid \`${tag}\` block`);
  const ok = !error;

  // Everything derived from the agent's own output is persisted and shown in
  // the UI, so it goes through redaction first -- an agent that echoed a
  // token would otherwise write a live credential into the run log forever.
  await runs.finishRun(run.id, {
    status: ok ? "succeeded" : "failed",
    summary: await redactSecrets(text.trim().slice(-4000)),
    error: error ? await redactSecrets(error) : null,
    costUsd,
  });
  // Only metered spend accumulates against the agent -- the engineering
  // manager is shown this alongside a menu that marks the subscription and
  // local models free, so a "free" agent showing a running dollar total
  // would contradict the very menu it decides from.
  await agents.recordRunResult(agent.id, { costUsd: billed ? (costUsd ?? undefined) : undefined, runMs });

  return { runId: run.id, ok, parsed, text: await redactSecrets(text), error, costUsd, runMs };
}
