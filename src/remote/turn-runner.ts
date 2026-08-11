import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Runtime } from "../runtime.js";
import { ensureHeadlessSettingsFile, type HookProfile } from "./headless-settings.js";

const PORT = process.env.PORT ?? "8787";

export type MessageContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export type TurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_final"; content: MessageContentBlock[] }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "turn_complete"; resultText: string; isError: boolean; costUsd?: number }
  | { type: "error"; message: string };

/** Thrown when `--resume <id>` targets a session Claude Code no longer has
 * on disk (e.g. the container restarted and wiped ~/.claude transcripts).
 * The caller retries once with a fresh session instead of surfacing it. */
export class ResumeSessionNotFoundError extends Error {}

/**
 * Parses one line of `claude -p --output-format stream-json`'s stdout.
 * Text is rendered from two sources deliberately: `text_delta` events
 * (from --include-partial-messages) drive live token-by-token typing, and
 * the top-level "assistant" event's full message content is the
 * authoritative final state for that message (text AND tool_use blocks --
 * tool_use input is read whole from here rather than reassembled from
 * input_json_delta fragments, which is simpler and doesn't depend on
 * getting streaming-JSON-fragment concatenation exactly right). The UI is
 * expected to treat message_final as "replace the in-progress bubble with
 * this," not "append."
 */
function handleParsedLine(json: Record<string, unknown>, onEvent: (event: TurnEvent) => void): void {
  if (json.type === "system" && json.subtype === "init" && typeof json.session_id === "string") {
    onEvent({ type: "session", sessionId: json.session_id });
    return;
  }

  if (json.type === "stream_event") {
    const event = json.event as Record<string, unknown> | undefined;
    if (event?.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        onEvent({ type: "text_delta", text: delta.text });
      }
    }
    return;
  }

  if (json.type === "assistant" && json.message && typeof json.message === "object") {
    const message = json.message as Record<string, unknown>;
    if (Array.isArray(message.content)) {
      const content: MessageContentBlock[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      onEvent({ type: "message_final", content });
    }
    return;
  }

  if (json.type === "user" && json.message && typeof json.message === "object") {
    const message = json.message as Record<string, unknown>;
    if (Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          onEvent({ type: "tool_result", toolUseId: block.tool_use_id, content, isError: !!block.is_error });
        }
      }
    }
    return;
  }

  if (json.type === "result") {
    onEvent({
      type: "turn_complete",
      resultText: typeof json.result === "string" ? json.result : "",
      isError: !!json.is_error,
      costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : undefined,
    });
  }
}

export interface RunTurnOptions {
  cwd: string;
  prompt: string;
  /** Continue an existing Claude Code conversation instead of starting a
   * new one. */
  resumeSessionId?: string;
  /** Role persona, appended to Claude Code's own system prompt rather than
   * replacing it -- the built-in prompt is what makes it competent with the
   * tools, and a PM role only needs to add to that, never to override it. */
  appendSystemPrompt?: string;
  /** Passed through as ANTHROPIC_MODEL. Usually a pinned
   * `custos:<provider>/<model>` alias (see providers/model-alias.ts), which
   * is how a PM agent gets exactly the provider it was assigned. */
  model?: string;
  /** Extra environment for the spawned process -- how vault secrets reach
   * an agent (see pm/vault.ts). Applied over the inherited environment. */
  env?: Record<string, string>;
  /** Permission posture -- see headless-settings.ts. Defaults to "chat". */
  hookProfile?: HookProfile;
  /** Tool names to hard-deny via `--disallowedTools`, passed straight
   *  through to the CLI (e.g. ["Bash", "Write", "Edit"]). This is a real
   *  gate, not a prompt request -- the model cannot invoke a denied tool
   *  regardless of how the conversation goes, unlike asking it not to in
   *  the system prompt. Use for roles that have no legitimate reason to
   *  touch the filesystem or run commands (e.g. the engineering manager,
   *  whose entire job is a JSON sizing/assignment decision from what's
   *  already in its prompt) -- a prose "don't do this" is easy for a
   *  model to ignore once a ticket description reads like an interesting
   *  problem to go dig into; a denied tool can't be invoked at all. */
  disallowedTools?: string[];
  /** Restricts which BUILT-IN tools exist for the turn at all, via
   *  `--tools` -- pass `[]` for "none of them" (the CLI's own `--tools ""`).
   *  This is a different mechanism from allowedTools/disallowedTools (both
   *  permission-layer concerns: what's pre-approved or hard-blocked once a
   *  tool call is attempted) -- `--tools` controls the built-in tool
   *  roster itself, so a tool cut here isn't attempted at all rather than
   *  attempted-then-blocked. Confirmed necessary in practice: disallowedTools
   *  alone kept missing newer built-ins (TaskCreate, TaskList, CronList,
   *  ListAgents -- a task/cron/agent-orchestration family that didn't exist
   *  when the original denylist was written), and each miss cost a full,
   *  slow turn on the model trying the wrong tool instead of the MCP tools
   *  actually given to it. Leave undefined for a normal run that needs its
   *  usual built-in toolbox (coding roles, chat); MCP-server tools (see
   *  mcpConfig) are unaffected either way, since they aren't part of "the
   *  built-in set" this flag governs. */
  tools?: string[];
  /** Inline `--mcp-config` JSON string (a `{"mcpServers": {...}}` document,
   * not a file path). Passed with `--strict-mcp-config` so the turn only
   * ever sees the MCP servers listed here, never anything else that might
   * be configured on the host's own ~/.claude. Used by portfolio chat
   * sessions to give the turn a self-referential connection back to
   * custos's own /mcp tools (see mcp/server.ts). */
  mcpConfig?: string;
  onEvent: (event: TurnEvent) => void;
  signal: AbortSignal;
}

/**
 * Runs exactly one turn: spawns `claude -p <text>` (a fresh process --
 * the CLI has no persistent multi-turn mode), streams parsed events to
 * onEvent as they arrive, and resolves once the process exits. Pass the
 * chat's previously-captured Claude session id as resumeSessionId to
 * continue the same conversation; omit it to start a new one.
 */
export async function runTurn(runtime: Runtime, options: RunTurnOptions): Promise<void> {
  const { cwd, prompt, resumeSessionId, appendSystemPrompt, model, onEvent, signal } = options;

  // Resolve the three-layer auth (OAuth mirror → static API key → synthetic
  // fallback) onto the subprocess env. The policy lives in credentials.ts so
  // unit tests can pin exactly when each layer activates without spawning a
  // real `claude` subprocess.
  const settingsPath = await ensureHeadlessSettingsFile(options.hookProfile ?? "chat");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // The spawned CLI always relays through the gateway -- the gateway
  // is the only path to the upstream, regardless of provider. The
  // /v1/messages handler dispatches via GlobalQueue so every call keeps
  // the operator-visible metrics (cooldowns, RPM, fallback chains, queue
  // depth) and goes through the same translation layer that lets
  // OpenAI-compat providers participate. ANTHROPIC_API_KEY is set only
  // when the auth policy above resolved one (static key or synthetic
  // fallback); when OAuth mirroring succeeded, no ANTHROPIC_API_KEY is
  // needed and the CLI uses the credentials file it wrote.
  env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`;
  if (model) env.ANTHROPIC_MODEL = model;
  // Claude Code only needs a non-empty key to pass its local startup check.
  // Provider authentication happens later, inside Custos's global queue.
  // Keeping this synthetic prevents expired Anthropic OAuth from blocking
  // turns assigned to Groq or a local model before they reach the gateway.
  env.ANTHROPIC_API_KEY = "custos-gateway";

  // The CLI's own stream-idle watchdog (confirmed by inspecting the
  // bundled binary's source) aborts a request after
  // max(CLAUDE_STREAM_IDLE_TIMEOUT_MS, 300_000)ms of receiving no stream
  // chunk at all -- 300s by default if the env var is unset, clamped to
  // [10s, 30min] however it's set. That's a real, separate mechanism
  // from the SDK's own overall request timeout and from anything on our
  // own gateway/upstream side: a request can legitimately spend up to
  // enqueueTimeoutMs (180s, see global-queue.ts) parked waiting for a
  // provider slot before it's even dispatched, then more time again
  // waiting on a slow upstream's first token (a cold local model, a
  // queued fallback) -- all before the CLI sees a single byte. Once that
  // combined wait crosses ~300s, the CLI gives up and the connection
  // dies with nothing to show for it; the spawned process doesn't
  // reliably notice and can sit "running" for the rest of its 45-minute
  // ceiling (see agent-runner.ts's dead-on-arrival watchdog, which
  // bounds the damage when this still happens for some other reason).
  // Set well above the realistic worst case for one turn, and safely
  // under both the CLI's own 30-minute hard cap and RUN_TIMEOUT_MS.
  env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(20 * 60_000);

  // Vault secrets last: they're the caller's explicit choice for this run,
  // and should win over anything the gateway process happens to inherit.
  Object.assign(env, options.env ?? {});

  // Both the prompt and the system-prompt addendum used to ride on argv
  // (`-p <prompt>` and `--append-system-prompt <text>`), which put them in
  // the same execve() buffer as the rest of the CLI's argument list and
  // environment. A ticket that's accumulated enough history, or an agent
  // whose engineering manager has appended enough standing instructions,
  // pushes that combined buffer past the OS's ARG_MAX and the spawn itself
  // fails with `E2BIG` before the CLI process even starts -- the render-side
  // caps in pm/context.ts (MAX_RENDERED_COMMENTS/HISTORY) bound the ticket
  // portion of the prompt, but appendSystemPrompt (an agent's full
  // accumulated notes, uncapped) was never covered by that and can grow
  // without bound on a long-lived agent. Neither has that ceiling now:
  // appendSystemPrompt goes to a temp file read via --append-system-prompt-file,
  // and the prompt itself goes over stdin instead of argv.
  const systemPromptFile = appendSystemPrompt
    ? join(tmpdir(), `custos-turn-system-prompt-${randomUUID()}.txt`)
    : null;
  if (systemPromptFile) await writeFile(systemPromptFile, appendSystemPrompt as string, "utf8");

  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  if (settingsPath) args.push("--settings", settingsPath);
  // Pushed as its own flag occurrence with every tool name as a separate
  // argv entry (not one space-joined string) so a tool name can never be
  // misparsed as a following flag the way a bare `--disallowedTools` with
  // no values immediately swallows whatever token comes next.
  if (options.disallowedTools?.length) args.push("--disallowedTools", ...options.disallowedTools);
  // undefined means "don't touch the built-in roster"; only an explicit
  // array (including []) pushes the flag at all.
  if (options.tools) args.push("--tools", options.tools.join(","));
  if (options.mcpConfig) args.push("--mcp-config", options.mcpConfig, "--strict-mcp-config");

  // The prior stdin attempt (see git history on this file) stalled because
  // stdio was left as a plain pipe that nothing ever wrote to -- the CLI
  // can't distinguish an empty pipe from slow input and sits waiting. Here
  // stdin is written and explicitly closed immediately after spawn, so the
  // CLI sees data followed by EOF right away, same as it would from a
  // redirected file.
  const proc = spawn("claude", args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
  // A write after the process has already exited (e.g. it errored out
  // before consuming stdin) would otherwise throw an unhandled EPIPE and
  // crash the whole gateway process -- the 'exit' handler below already
  // reports the failure via stderrBuf, so this is just a no-op sink.
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt);

  let resumeNotFound = false;
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line);
    } catch {
      return; // Non-JSON line on stdout -- ignore rather than crash the turn.
    }
    // A resume against a missing session id fails as an error result whose
    // only content is this specific error -- swallow it (don't emit a
    // spurious turn_complete) and flag for a fresh retry after exit.
    if (
      json.type === "result" &&
      json.subtype === "error_during_execution" &&
      Array.isArray(json.errors) &&
      (json.errors as unknown[]).some((e) => typeof e === "string" && e.includes("No conversation found"))
    ) {
      resumeNotFound = true;
      return;
    }
    handleParsedLine(json, onEvent);
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("error", (err) => reject(err));
      proc.on("exit", (code) => {
        rl.close();
        if (resumeNotFound) {
          reject(new ResumeSessionNotFoundError());
          return;
        }
        if (code !== 0 && code !== null && stderrBuf.trim()) {
          onEvent({ type: "error", message: stderrBuf.trim().slice(0, 2000) });
        }
        resolve();
      });
    });
  } finally {
    // Best-effort: a leaked temp file per turn is a nuisance, not a
    // correctness problem, so a cleanup failure shouldn't mask the turn's
    // real outcome (success or the error/rejection above).
    if (systemPromptFile) await rm(systemPromptFile, { force: true }).catch(() => {});
  }
}
