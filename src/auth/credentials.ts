import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshTokens, type TokenSet } from "./oauth.js";

const CREDENTIALS_PATH = process.env.GATEWAY_CREDENTIALS_PATH ?? join(process.cwd(), "data", "credentials.json");
const CLAUDE_CODE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadStoredTokens(): Promise<TokenSet | null> {
  return readJson<TokenSet>(CREDENTIALS_PATH);
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

/** Removes Custos's own stored tokens. Doesn't affect Claude Code's own
 * credentials file -- if Custos has no tokens of its own afterward, the
 * next request just re-imports from Claude Code again if that's present. */
export async function clearTokens(): Promise<void> {
  await rm(CREDENTIALS_PATH, { force: true });
}

/**
 * One-time convenience: pull the token Claude Code itself is already logged
 * in with, so `npm run login` isn't required if the CLI on this machine is
 * already authenticated. Only used as a fallback when we have no tokens yet.
 */
async function importFromClaudeCode(): Promise<TokenSet | null> {
  interface ClaudeCodeCredentials {
    claudeAiOauth?: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
  }
  const raw = await readJson<ClaudeCodeCredentials>(CLAUDE_CODE_CREDENTIALS_PATH);
  const oauth = raw?.claudeAiOauth;
  if (!oauth) return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

export interface OAuthStatus {
  connected: boolean;
  source?: "custos" | "claude-code";
  expiresAt?: number;
}

/** Reports whether an OAuth session is available and where it came from,
 * without ever exposing the token itself. */
export async function getOAuthStatus(): Promise<OAuthStatus> {
  const stored = await loadStoredTokens();
  if (stored) return { connected: true, source: "custos", expiresAt: stored.expiresAt };

  const imported = await importFromClaudeCode();
  if (imported) return { connected: true, source: "claude-code", expiresAt: imported.expiresAt };

  return { connected: false };
}

/** Returns a valid (non-expired) access token, refreshing and persisting if needed. */
export async function getValidAccessToken(): Promise<string | null> {
  let tokens = (await loadStoredTokens()) ?? (await importFromClaudeCode());
  if (!tokens) return null;

  if (tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    tokens = await refreshTokens(tokens.refreshToken);
    await saveTokens(tokens);
  } else {
    // Persist an import from Claude Code so future calls don't need to
    // re-read its credentials file, and refresh cycles stay independent.
    await saveTokens(tokens);
  }

  return tokens.accessToken;
}
