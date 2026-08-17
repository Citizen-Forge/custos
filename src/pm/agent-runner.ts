// Runs one autonomous agent to completion. The surrounding concerns --
// contract extraction, system-prompt assembly, tool policy, and the
// AgentRunResult/RunAgentOptions types -- live under ./agent-runner/, split
// out because they're independently pure/self-contained; this file keeps
// only the `runAgent` dispatch flow itself, which is one tightly-sequenced
// operation (resolve fallback -> pre-spawn probe -> dispatch -> collect
// events -> finalize the run) that doesn't split cleanly without just
// moving its own internal coupling across file boundaries.
import type { Runtime } from "../runtime.js";
import { runTurn, type TurnEvent } from "../remote/turn-runner.js";
import { getProject } from "../remote/projects.js";
import { formatFallbackAlias } from "../providers/model-alias.js";
import { resolveAgentEnv, redactSecrets } from "./vault.js";
import * as runs from "./runs.js";
import * as agents from "./agents.js";
import { RUN_TIMEOUT_MS } from "./types.js";
import { ProbeUnavailableError, runPreSpawnProbe } from "./probe.js";
import { extractContract } from "./agent-runner/contract.js";
import { buildSystemPrompt } from "./agent-runner/system-prompt.js";
import { DISALLOWED_TOOLS_BY_TAG, TOOL_FREE_TAGS, TOOL_ALLOWLIST_BY_TAG } from "./agent-runner/tool-policy.js";
import { describeEvent } from "./agent-runner/describe-event.js";
import type { AgentRunResult, RunAgentOptions } from "./agent-runner/types.js";

export type { AgentRunResult, RunAgentOptions } from "./agent-runner/types.js";
export { extractContract } from "./agent-runner/contract.js";
export { buildSystemPrompt } from "./agent-runner/system-prompt.js";
export { DISALLOWED_TOOLS_BY_TAG, TOOL_FREE_TAGS, TOOL_ALLOWLIST_BY_TAG } from "./agent-runner/tool-policy.js";

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
  // Resolve the agent's primary pick from its fallbackSet so we record
  // cost against what actually ran, not whatever stale providerKey the
  // agent row on disk still carries from before the schema drop.
  //   1. The acquireSlot path -- runtime.resolveFallbackSet() reads the
  //      fallbackSet, asks ProviderStateMap which providers are accepting
  //      work, and returns the first one with a slot already held. This is
  //      the actual provider the run will dispatch to, and the only one
  //      ever actually probed below.
  //   2. primaryPick(agent, config) -- the operator-facing primary pick
  //      (just fallbackSet[0], availability-blind). Used ONLY to fill in
  //      effectiveProviderKey/effectiveModel for the early-return failure
  //      right below when resolveFallbackSet comes back null, so that
  //      failure still has something informative to report. Never handed
  //      to the probe -- see the comment on the `if (!resolved)` branch
  //      for why that distinction matters.
  //   3. null -- only possible if the agent has no fallbackSet at all (a
  //      legacy state that migrateToFallbackSets should have resolved; an
  //      unmitigated error here surfaces as a clear 503 at dispatch time
  //      rather than a silent wrong-provider bill).
  const resolved = runtime.resolveFallbackSet(agent);
  const primary = agents.primaryPick(agent, runtime.config);
  const effectiveProviderKey = resolved?.providerKey ?? primary?.providerKey ?? null;
  const effectiveModel = resolved?.model ?? primary?.model ?? null;
  let releaseSlot = resolved?.release ?? null;
  if (!effectiveProviderKey || !effectiveModel) {
    throw new Error(`agent ${agent.id} has no fallbackSet or no live primary pick; the PM must assign one before this run can be dispatched`);
  }
  // primaryPick is just `fallbackSet[0]` with no regard for whether that
  // entry is actually enabled or accepting work -- it's meant for display
  // ("runs on X/Y" in the roster), not dispatch. resolveFallbackSet is the
  // one that's availability-aware (walks the chain via
  // ProviderStateMap.canAccept, skipping anything disabled/cooling/at
  // capacity); when it returns null the ENTIRE chain is currently
  // unavailable, not just its first entry. Probing primary's guess in that
  // case used to burn a full dispatch attempt on a provider we already
  // know can't work -- observed live: "complex" is [anthropic, local],
  // anthropic is deliberately disabled, and the moment `local` was
  // momentarily at its maxConcurrent:1 ceiling, this fell through to
  // probing anthropic (permanently disabled, never registered) instead of
  // just waiting for `local` to free up, failing the whole EM assignment
  // pass on every occurrence with "no registered provider for anthropic".
  if (!resolved) {
    if (releaseSlot) releaseSlot();
    return {
      runId: `probe-failed-${Date.now().toString(36)}`,
      ok: false,
      parsed: null,
      text: "",
      error: `no provider in ${agent.fallbackSet ?? "(no fallback set)"}'s chain is currently available (disabled, cooling, or at capacity) -- will retry`,
      costUsd: null,
      runMs: 0,
      unavailable: true,
    };
  }
  // Pre-spawn probe: a 1-token ping to the resolved provider+model.
  // Sits between resolveFallbackSet (which acquired the concurrency
  // slot) and runs.startRun (which would create a run artefact) so a
  // failed probe leaves no run record but propagates back through
  // AgentRunResult.error (and .unavailable=true) -- the orchestrator's
  // existing failure path surfaces the reason to the activity feed
  // without applying per-ticket attempt backoff, since nothing was ever
  // actually dispatched. Probe failures bypass the GlobalQueue entirely
  // so the pre-acquired slot isn't double-counted toward maxConcurrent
  // and the activity log isn't polluted by a mark-cooling cascade for
  // what is really a "don't even try" signal.
  try {
    await runPreSpawnProbe(runtime, effectiveProviderKey, effectiveModel);
  } catch (err) {
    if (err instanceof ProbeUnavailableError) {
      if (releaseSlot) releaseSlot();
      return {
        runId: `probe-failed-${Date.now().toString(36)}`,
        ok: false,
        parsed: null,
        text: "",
        error: err.message,
        unavailable: true,
        costUsd: null,
        runMs: 0,
      };
    }
    // Any non-ProbeUnavailableError from the probe (network timeout,
    // TypeError, "no registered provider", ProviderUnavailableError
    // re-thrown from the bare provider on 429/5xx) would otherwise
    // leave the concurrency slot acquired by `resolveFallbackSet`
    // pinned until the next process restart. Release here so the
    // slot is freed regardless of how the probe failed.
    if (releaseSlot) releaseSlot();
    throw err;
  }
  // Release the slot the moment the probe confirms the provider is
  // live -- it was only ever meant to guard against spawning the
  // (expensive) CLI subprocess against a provider that's actually
  // unavailable, not to reserve capacity for the run's entire
  // lifetime. Every real request this run makes goes through
  // GlobalQueue, which does its own acquire/release per dispatch
  // against this same ProviderStateMap; holding this slot any longer
  // double-counts against maxConcurrent for work the queue is already
  // accounting for. At maxConcurrent=1 that was a hard deadlock: the
  // outer hold consumed the only slot for the run's whole duration,
  // so the run's own dispatches -- competing for that same exhausted
  // capacity -- could never get a slot to make the progress that
  // would let the outer hold ever release.
  releaseSlot?.();
  releaseSlot = null;
  // Whether this run's reported cost is real money is decided here, from
  // the provider/model that the run will actually dispatch against --
  // see agents.listProviderOptions. A free subscription ride counts as
  // free, regardless of what's on disk in the agents.json row.
  const billed = !agents.listProviderOptions(runtime.config).find((o) => o.providerKey === effectiveProviderKey && o.model === effectiveModel)?.free;
  const run = await runs.startRun({
    projectId,
    agentId: agent.id,
    role: agent.role,
    providerKey: effectiveProviderKey,
    model: effectiveModel,
    billed,
    workItemId: options.workItemId,
    ideaId: options.ideaId,
    tag,
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
    // Look up the project here (not from the agent row) so a rename on
    // the board shows up immediately in the activity log rather than
    // waiting for the agent row to be re-persisted. If the project has
    // been deleted between scheduling and dispatch, surface the throw
    // through the existing catch -- a missing project is a real failure,
    // not a "use the GUID as a name" fallback.
    const project = await getProject(projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    await runTurn(runtime, {
      cwd,
      // The contract lives in the system prompt, but a provider whose
      // context window is smaller than the prompt silently truncates -- and
      // what gets dropped is the front, which is exactly where the system
      // prompt sits. The agent then answers in prose, the contract block
      // never appears, and a whole run is wasted. Restating the requirement
      // at the very end costs a line and survives that truncation.
      // Skipped for tool-driven runs -- there's no block to remind it about.
      prompt: options.toolDriven ? prompt : `${prompt}\n\n---\n\nRemember: your final message must end with exactly one fenced \`${tag}\` block containing valid JSON, and nothing after it.`,
      appendSystemPrompt: buildSystemPrompt(agent, options.extraSystemPrompt, options.outputContract),
      mcpConfig: options.mcpConfig,
      // Append caller context (project + agent identity) after `?` so the
      // gateway's /v1/messages handler can recover it and attribute the
      // resulting activity-log events back to the project + agent that
      // triggered them. Without this the queue's dispatch events would be
      // visible but anonymous in the admin panel. `projectName` is
      // looked up above (just before runTurn) because the project file
      // is the source of truth -- a rename on the board shows up
      // immediately rather than waiting for the agent row to be
      // re-persisted, which never happens for legacy agents.
      model: formatFallbackAlias(agent.fallbackSet as string, {
        projectId,
        projectName: project.name,
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        ...(options.workItemId ? { workItemId: options.workItemId } : {}),
      }),
      env: await resolveAgentEnv(projectId),
      hookProfile: "agent",
      disallowedTools: DISALLOWED_TOOLS_BY_TAG[tag],
      tools: TOOL_FREE_TAGS.has(tag) ? [] : TOOL_ALLOWLIST_BY_TAG[tag],
      onEvent,
      signal: controller.signal,
    });
  } catch (err) {
    turnError = (err as Error).message;
  } finally {
    clearTimeout(deadline);
  }

  const runMs = Date.now() - startedAt;
  if (timedOut) turnError = `the run was aborted after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes without finishing`;
  // Tool-driven runs already applied every decision as each tool call
  // landed -- there's no trailing block to require, so success is just
  // "the turn finished without erroring or timing out".
  const parsed = options.toolDriven ? null : extractContract<T>(text, tag);
  const error = turnError ?? (options.toolDriven || parsed ? null : `the agent did not return a valid \`${tag}\` block`);
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

  // Also record against the project-level spend tracker so the
  // orchestrator can check the project's budget without re-aggregating
  // individual run records. Only billed (metered) spend counts. Records
  // the *actual* provider that served the run (the resolved pair), not
  // anything stale on the agent row -- the agent could be on fallback
  // set "complex" while the runtime dispatched to entry [1] because [0]
  // was rate-limited, and the spend follows the run, not the config.
  if (billed && costUsd != null && costUsd > 0) {
    await runtime.spendTracker.record(projectId, effectiveProviderKey, costUsd);
  }

  return { runId: run.id, ok, parsed, text: await redactSecrets(text), error, costUsd, runMs };
}
