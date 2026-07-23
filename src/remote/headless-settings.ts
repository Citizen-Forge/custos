import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const PORT = process.env.PORT ?? "8787";

/**
 * Every one-shot `claude -p` turn spawned for a chat-mode chat runs inside
 * this same container under the same HOME, so they all share one
 * ~/.claude/settings.json. Wires PreToolUse at the headless variant of the
 * permission hook (see routes.ts's /hooks/pretooluse-headless -- "ask"
 * coerced to "deny", since there's no TTY in `-p` mode to interactively
 * resolve it) and UserPromptSubmit at the normal memory-search hook.
 * Merges into any existing file rather than overwriting it, in case the
 * user has mounted their own ~/.claude with other settings.
 */
export async function ensureHeadlessSettingsFile(clientApiKey?: string): Promise<void> {
  const baseUrl = `http://localhost:${PORT}`;
  const headers = clientApiKey ? { "x-api-key": clientApiKey } : undefined;

  const hookEntry = (path: string, timeout: number) => ({
    hooks: [{ type: "http", url: `${baseUrl}${path}`, timeout, ...(headers ? { headers } : {}) }],
  });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const existingHooks = (existing.hooks as Record<string, unknown>) ?? {};
  const merged = {
    ...existing,
    hooks: {
      ...existingHooks,
      PreToolUse: [hookEntry("/hooks/pretooluse-headless", 30)],
      UserPromptSubmit: [hookEntry("/hooks/user-prompt-submit", 15)],
    },
  };

  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
}
