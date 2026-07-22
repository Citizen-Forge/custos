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

/** Custos's own stored tokens (not an import), refreshed and persisted if
 * close to expiring. Null if Custos has never connected its own OAuth
 * session -- callers that also want to fall back to an import from Claude
 * Code's own credentials file should use getValidAccessToken instead. */
async function getValidOwnTokenSet(): Promise<TokenSet | null> {
  const stored = await loadStoredTokens();
  if (!stored) return null;
  if (stored.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    const refreshed = await refreshTokens(stored.refreshToken);
    await saveTokens(refreshed);
    return refreshed;
  }
  return stored;
}

/** Returns a valid (non-expired) access token, refreshing and persisting if needed. */
export async function getValidAccessToken(): Promise<string | null> {
  const own = await getValidOwnTokenSet();
  if (own) return own.accessToken;

  const imported = await importFromClaudeCode();
  if (!imported) return null;
  // Persist an import from Claude Code so future calls don't need to
  // re-read its credentials file, and refresh cycles stay independent.
  await saveTokens(imported);
  return imported.accessToken;
}

/**
 * Projects Custos's own connected OAuth session into the file format the
 * real Claude Code CLI reads (~/.claude/.credentials.json), so a
 * remote-spawned `claude` process is already authenticated and skips its
 * own /login. Only acts when Custos has its OWN tokens (getValidOwnTokenSet,
 * not the import fallback) -- if Custos has never connected via the admin
 * panel's OAuth flow, this is a no-op, so it never clobbers a deliberately
 * host-mounted ~/.claude with nothing new to offer.
 */
export async function syncSpawnedSessionCredentials(): Promise<void> {
  const tokens = await getValidOwnTokenSet();
  if (!tokens) return;

  // The real file needs more than {accessToken, refreshToken, expiresAt} --
  // the CLI does its own local "am I logged in" check before ever making a
  // network request, and a file missing `scopes` fails that check silently
  // (surfaces as a synthetic "Not logged in" reply with zero API time, not
  // an error). The extra fields live in Anthropic's token-response JSON
  // (captured verbatim as `raw` in oauth.ts) under names that don't match
  // the credentials file's camelCase, so map defensively -- extraction
  // omits a field rather than guessing wrong if the shape doesn't match.
  const raw = tokens.raw ?? {};
  const claudeAiOauth: Record<string, unknown> = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
  if (typeof raw.refresh_token_expires_in === "number") {
    claudeAiOauth.refreshTokenExpiresAt = Date.now() + raw.refresh_token_expires_in * 1000;
  }
  if (typeof raw.scope === "string") {
    claudeAiOauth.scopes = raw.scope.split(" ").filter(Boolean);
  }
  const account = raw.account as Record<string, unknown> | undefined;
  const organization = raw.organization as Record<string, unknown> | undefined;
  const subscriptionType = account?.subscription_type ?? organization?.subscription_type;
  if (typeof subscriptionType === "string") claudeAiOauth.subscriptionType = subscriptionType;
  const rateLimitTier = account?.rate_limit_tier ?? organization?.rate_limit_tier;
  if (typeof rateLimitTier === "string") claudeAiOauth.rateLimitTier = rateLimitTier;

  await mkdir(dirname(CLAUDE_CODE_CREDENTIALS_PATH), { recursive: true });
  await writeFile(CLAUDE_CODE_CREDENTIALS_PATH, JSON.stringify({ claudeAiOauth }, null, 2), "utf8");
}
