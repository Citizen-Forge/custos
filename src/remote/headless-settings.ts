import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
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
 * ~/.claude/settings.json. Chat turns use that shared file; autonomous
 * agent runs get their own sidecar file passed with `--settings`, since
 * they need a different PreToolUse endpoint and the two kinds of run
 * happen concurrently.
 *
 * Both are merged into any existing settings rather than overwriting them,
 * in case the user has mounted their own ~/.claude with other settings.
 *
 * Returns the path to pass as `--settings`, or null when the global file is
 * already the right one.
 */
export async function ensureHeadlessSettingsFile(profile: HookProfile = "chat"): Promise<string | null> {
  const existing = await readExistingSettings();
  const existingHooks = (existing.hooks as Record<string, unknown>) ?? {};

  if (profile === "chat") {
    const merged = { ...existing, hooks: { ...existingHooks, ...buildHooks("/hooks/pretooluse-headless") } };
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
    return null;
  }

  const merged = { ...existing, hooks: { ...existingHooks, ...buildHooks("/hooks/pretooluse-agent") } };
  await mkdir(dirname(AGENT_SETTINGS_PATH), { recursive: true });
  await writeFile(AGENT_SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return AGENT_SETTINGS_PATH;
}
