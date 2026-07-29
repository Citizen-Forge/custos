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

async function getValidOwnTokenSet(): Promise<TokenSet | null> {
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

/**
 * Projects Custos's own connected OAuth session into the file format the
 * real Claude Code CLI reads (~/.claude/.credentials.json), so a
 * remote-spawned `claude` process is already authenticated and skips its
 * own /login. Only acts when Custos has its OWN tokens (getValidOwnTokenSet,
 * not the import fallback) -- if Custos has never connected via the admin
 * panel's OAuth flow, this is a no-op, so it never clobbers a deliberately
 * host-mounted ~/.claude with nothing new to offer.
 */
export interface SyncSpawnedSessionCredentialsResult {
  /** What the mirror function actually did. `mirrored` = wrote the file
   * with valid tokens; `skipped` = nothing to mirror (no stored tokens);
   * `skipped-empty` = input was empty/malformed and we refused to
   * clobber the existing file (logged at warn); `failed` = I/O error or
   * the persistence-side validity predicate refused to write. Lets
   * callers and tests tell the difference between "we deleted auth
   * intentionally" and "we couldn't mirror because the input was bad". */
  outcome: "mirrored" | "skipped" | "skipped-empty" | "failed";
}

export async function syncSpawnedSessionCredentials(): Promise<SyncSpawnedSessionCredentialsResult> {
  const tokens = await getValidOwnTokenSet();
  if (!tokens) return { outcome: "skipped" };
  if (!isValidTokenSet(tokens)) {
    // REFUSE TO WRITE IF THE TOP-LEVEL FIELDS ARE EMPTY.
    // Pre-fix, a TokenSet with populated `raw` block but empty
    // accessToken / refreshToken / expiresAt could land here (the most
    // surprising path was importFromClaudeCode() persisted via
    // saveTokens when the spawned CLI had read an already-empty
    // ~/.claude/.credentials.json). Writing that shape to the file the
    // spawned `claude -p` subprocess reads at startup gives Claude Code
    // an empty accessToken to fail on, which surfaces as the
    // "OAuth session expired and could not be refreshed" error the user
    // sees for EVERY agent call -- including ones using non-Anthropic
    // providers, because the local-login check happens before any
    // network request, regardless of which provider the request is for.
    // The mirror is best-effort: a broken TokenSet must not clobber a
    // previously-good file. saveTokens() also enforces this same
    // invariant for the data/credentials.json side (the bidirectional
    // arm of the regression: an empty mirror used to be able to
    // clobber valid gateway-side tokens on a saveTokens import).
    console.warn(
      `[credentials] refusing to mirror OAuth tokens to ${CLAUDE_CODE_CREDENTIALS_PATH}: ` +
      `accessToken=${tokens.accessToken ? "set" : "missing"}, ` +
      `refreshToken=${tokens.refreshToken ? "set" : "missing"}, ` +
      `expiresAt=${tokens.expiresAt ?? "missing"}. ` +
      `If this keeps appearing, reconnect via the admin OAuth panel; in the meantime ` +
      `turn-runner.ts will fall back to ANTHROPIC_API_KEY=auth-ok when set in config.`,
    );
    return { outcome: "skipped-empty" };
  }

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
  try {
    await writeFile(CLAUDE_CODE_CREDENTIALS_PATH, JSON.stringify({ claudeAiOauth }, null, 2), "utf8");
    return { outcome: "mirrored" };
  } catch (err) {
    console.error(`[credentials] failed to mirror OAuth tokens to ${CLAUDE_CODE_CREDENTIALS_PATH}: ${(err as Error).message}`);
    return { outcome: "failed" };
  }
}
