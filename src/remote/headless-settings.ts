import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const CHAT_SETTINGS_PATH = join(CLAUDE_DIR, "custos-chat-settings.json");
const AGENT_SETTINGS_PATH = join(CLAUDE_DIR, "custos-agent-settings.json");
const PORT = process.env.PORT ?? "8787";

/** Which permission posture a spawned turn runs under.
 *
 * - "chat" — a human is attached to the transcript, so anything the
 *   classifier doesn't outright allow is surfaced to them and the hook
 *   blocks until they answer.
 * - "agent" — an autonomous PM run with nobody watching. There is no one to
 *   ask, so "ask" verdicts proceed and only a hard "deny" blocks. That's a
 *   real widening of what an agent may do unsupervised, which is why
 *   autonomy is opt-in per project and per role in project settings. */
export type HookProfile = "chat" | "agent";

async function readExistingSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {};
  }
}

function buildHooks(hookPath: string): Record<string, unknown> {
  // Hook URLs no longer carry an `x-api-key` header. custos is no longer
  // a Claude Code proxy, so the /hooks/* endpoints are reachable only
  // from custos's own spawned subprocesses; client-auth-guard.ts is a
  // no-op stub (see that file's header) and no shared secret travels
  // across the wire. Auth gates that DO still apply (admin/remote/app
  // session login) are unrelated to the hook surface.
  const baseUrl = `http://localhost:${PORT}`;
  const hookEntry = (path: string, timeout: number) => ({
    hooks: [{ type: "http", url: `${baseUrl}${path}`, timeout }],
  });
  return {
    // 300s: the chat variant can block while a human approves/denies a
    // flagged action in the UI (routes.ts holds the response open, with its
    // own 270s internal cap so it always answers before this fires). The
    // agent variant never blocks that long, but shares the timeout so both
    // profiles fail the same way if the gateway itself stops responding.
    PreToolUse: [hookEntry(hookPath, 300)],
    UserPromptSubmit: [hookEntry("/hooks/user-prompt-submit", 15)],
  };
}

/**
 * Every one-shot `claude -p` turn spawned by Custos runs inside this same
 * container under the same HOME, so they'd all share one
 * ~/.claude/settings.json.
 *
 * Both profiles get their own dedicated sidecar file passed with
 * `--settings`, because Claude Code does NOT treat `--settings` as
 * replacing the global settings.json's hooks -- it loads the global file
 * unconditionally and layers `--settings` on top, running hooks from BOTH
 * for the same event rather than one overriding the other. The original
 * version of this function wrote the "chat" profile's PreToolUse hook
 * straight into the global file on the (wrong) assumption that an
 * autonomous agent turn's own `--settings` sidecar would be the only thing
 * in effect for that turn. In practice every agent-profile turn ALSO had
 * the global file's chat hook fire for every tool call, and that hook
 * denies outright when it can't find a matching interactive chat session
 * (see routes.ts's "chat session not found to ask in") -- which every
 * autonomous run hits by construction, since there is no chat session.
 * Confirmed live: an engineering-manager run's own MCP tool call was
 * silently denied by this stale global-file hook, not by anything in the
 * agent-profile path itself -- groomBacklog/assignReady/curateFacts had
 * never landed a single real tool call in production because of this.
 *
 * Fix: neither profile ever writes hooks into the global file anymore, and
 * any hooks key already there (from before this fix, or from a user's own
 * mounted ~/.claude) is stripped on the next call so it can't keep firing
 * unasked-for alongside a profile's own sidecar. Non-hook keys in the
 * global file are still preserved and folded into each sidecar, in case
 * the user has other settings (permissions, model prefs) configured there.
 *
 * Returns the path to pass as `--settings`.
 */
export async function ensureHeadlessSettingsFile(profile: HookProfile = "chat"): Promise<string> {
  const global = await readExistingSettings();
  const hadGlobalHooks = "hooks" in global;
  const { hooks: _globalHooks, ...globalWithoutHooks } = global;

  if (hadGlobalHooks) {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(globalWithoutHooks, null, 2), "utf8");
  }

  const sidecarPath = profile === "chat" ? CHAT_SETTINGS_PATH : AGENT_SETTINGS_PATH;
  const hookPath = profile === "chat" ? "/hooks/pretooluse-headless" : "/hooks/pretooluse-agent";
  const merged = { ...globalWithoutHooks, hooks: buildHooks(hookPath) };
  await mkdir(dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, JSON.stringify(merged, null, 2), "utf8");
  return sidecarPath;
}
