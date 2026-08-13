// The gateway's own OAuth token store: read/write/refresh against
// data/credentials.json, plus the one-time import fallback from a
// locally-logged-in Claude Code CLI. subprocess-auth.ts builds on top
// of this (getValidOwnTokenSet, CLAUDE_CODE_CREDENTIALS_PATH) to mirror
// a session into the format the spawned CLI reads.
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshTokens, type TokenSet } from "../oauth.js";
import { readJsonFile, writeJsonFile } from "../../util/json-file.js";

export const CREDENTIALS_PATH = process.env.GATEWAY_CREDENTIALS_PATH ?? join(process.cwd(), "data", "credentials.json");
export const CLAUDE_CODE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function loadStoredTokens(): Promise<TokenSet | null> {
  return readJsonFile<TokenSet | null>(CREDENTIALS_PATH, null);
}

/** True when the TokenSet has the three fields that the gateway and the
 * spawned Claude Code subprocess both require to authenticate. Originally
 * a private inline check in syncSpawnedSessionCredentials, lifted to a
 * named predicate after the auth regression where saveTokens('d an empty
 * TokenSet clobbered data/credentials.json (via the
 * getValidAccessToken → importFromClaudeCode → saveTokens path) and the
 * mirror function then wrote a corresponding empty shape back over
 * ~/.claude/.credentials.json. Pushing the check into saveTokens() makes
 * it impossible to persist empty tokens from either caller; the mirroring
 * caller additionally refuses to write its own file in the same condition
 * so that a corrupted auth store can't smear a previously-good mirror. */
export function isValidTokenSet(tokens: TokenSet | null | undefined): boolean {
  if (!tokens) return false;
  return Boolean(tokens.accessToken) && Boolean(tokens.refreshToken) && typeof tokens.expiresAt === "number" && tokens.expiresAt > 0;
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  // Refuse to persist a malformed TokenSet. Two paths reach here:
  //   (a) refreshOnce() after a successful refresh — Anthropic's response
  //       is always well-shaped, so this is a no-op for the happy path.
  //   (b) getValidAccessToken() after a successful
  //       importFromClaudeCode() — returns the three fields Claude Code
  //       itself wrote at /root when it last logged in. If those fields
  //       happen to be empty (a stale or pre-OAuth Claude Code install
  //       on the host, or a freshly-created container before the first
  //       OAuth connect), this is where an empty save would otherwise
  //       overwrite the gateway's own valid data with empty values, and
  //       a later syncSpawnedSessionCredentials call would then write
  //       an empty ~/.claude/.credentials.json mirror — clobbering both
  //       the auth store AND the mirror in a single bad boot. Throwing
  //       here turns the silent corruption into an observable failure
  //       the gateway can log and the operator can act on.
  if (!isValidTokenSet(tokens)) {
    throw new Error(
      `refusing to persist malformed TokenSet: accessToken=${tokens.accessToken ? "set" : "missing"}, ` +
      `refreshToken=${tokens.refreshToken ? "set" : "missing"}, expiresAt=${tokens.expiresAt ?? "missing"}`,
    );
  }
  await writeJsonFile(CREDENTIALS_PATH, tokens);
}

/** Removes Custos's own stored tokens AND the mirror at
 * ~/.claude/.credentials.json. The mirror is not an independent host
 * login in this deployment -- syncSpawnedSessionCredentials() only ever
 * writes it as a projection of Custos's own tokens (getValidOwnTokenSet,
 * never the import fallback), so it's purely a reflection of whatever
 * Custos last connected. Clearing only CREDENTIALS_PATH left that stale
 * reflection in place: the very next getOAuthStatus() call would fall
 * back to importFromClaudeCode(), find the still-valid mirror, and
 * report connected again with source "claude-code" -- Disconnect
 * appearing to silently undo itself. */
export async function clearTokens(): Promise<void> {
  await rm(CREDENTIALS_PATH, { force: true });
  await rm(CLAUDE_CODE_CREDENTIALS_PATH, { force: true });
}

/**
 * One-time convenience: pull the token Claude Code itself is already logged
 * in with, so `npm run login` isn't required if the CLI on this machine is
 * already authenticated. Only used as a fallback when we have no tokens yet.
 */
export async function importFromClaudeCode(): Promise<TokenSet | null> {
  interface ClaudeCodeCredentials {
    claudeAiOauth?: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
  }
  const raw = await readJsonFile<ClaudeCodeCredentials | null>(CLAUDE_CODE_CREDENTIALS_PATH, null);
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

/**
 * In-flight refresh, shared by every concurrent caller.
 *
 * Anthropic's refresh tokens are single-use and rotate on redemption. With
 * several agents running at once they all call getValidAccessToken() at the
 * same moment, and once the access token is inside the refresh margin every
 * one of them redeems the *same* refresh token: the first wins and the rest
 * come back `invalid_grant` — which then looks exactly like "your OAuth
 * session is broken" and requires reconnecting by hand. Collapsing them into
 * one request is the whole fix.
 */
let refreshInFlight: Promise<TokenSet> | null = null;

async function refreshOnce(refreshToken: string): Promise<TokenSet> {
  if (!refreshInFlight) {
    refreshInFlight = refreshTokens(refreshToken)
      .then(async (refreshed) => {
        await saveTokens(refreshed);
        return refreshed;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** Custos's own stored tokens (not an import), refreshed and persisted if
 * close to expiring. Null if Custos has never connected its own OAuth
 * session -- callers that also want to fall back to an import from Claude
 * Code's own credentials file should use getValidAccessToken instead. */
export async function getValidOwnTokenSet(): Promise<TokenSet | null> {
  const stored = await loadStoredTokens();
  if (!stored) return null;
  if (stored.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    return refreshOnce(stored.refreshToken);
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
