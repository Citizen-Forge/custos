import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Runtime } from "../runtime.js";
import { syncSpawnedSessionCredentials } from "../auth/credentials.js";
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
  /** Permission posture -- see headless-settings.ts. Defaults to "chat". */
  hookProfile?: HookProfile;
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
  await syncSpawnedSessionCredentials();
  const settingsPath = await ensureHeadlessSettingsFile(runtime.config.clientApiKey, options.hookProfile ?? "chat");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`;
  if (runtime.config.clientApiKey) env.ANTHROPIC_API_KEY = runtime.config.clientApiKey;
  if (model) env.ANTHROPIC_MODEL = model;

  const args = ["-p", prompt, "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  if (settingsPath) args.push("--settings", settingsPath);

  // stdin = 'ignore' (i.e. /dev/null) so the CLI gets an immediate EOF
  // instead of waiting on a pipe that never receives data -- with a plain
  // piped stdin it warns "no stdin data received in 3s" and stalls, since
  // it can't tell an empty pipe from slow piped input. The prompt is passed
  // as the `-p` argument, so no stdin is needed at all.
  const proc = spawn("claude", args, { cwd, env, signal, stdio: ["ignore", "pipe", "pipe"] });

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
}
