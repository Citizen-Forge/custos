// Auth resolution for spawned `claude -p` subprocesses: mirroring the
// gateway's own OAuth session into the file format the Claude Code CLI
// reads, and resolving the ANTHROPIC_API_KEY env var each subprocess
// launches with. Builds on ./store.ts's token lifecycle rather than
// touching data/credentials.json itself.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenSet } from "../oauth.js";
import { CLAUDE_CODE_CREDENTIALS_PATH, getValidOwnTokenSet, isValidTokenSet } from "./store.js";

/**
 * Three-layer auth for spawned `claude -p` subprocesses.
 *
 * Each spawned Claude Code CLI needs some form of credentials to pass its
 * local startup auth check. This function resolves that from the gateway's
 * configured auth sources in priority order.
 *
 * **Execution order** differs from **return-value priority**: Layer 1
 * (the OAuth mirror side effect — writing to ~/.claude/.credentials.json)
 * always runs first, because it keeps the mirror file fresh regardless of
 * which layer wins the return-value check. The return-value priority is:
 *
 *   Layer 2 — Static API key: if the gateway config has an Anthropic API
 *   key, pass it as ANTHROPIC_API_KEY. The CLI prefers API-key auth over
 *   OAuth when both are present, so this takes highest return priority.
 *
 *   Layer 1 — OAuth mirror: when the mirror succeeds
 *   (outcome === "mirrored") and no static key is configured, no
 *   ANTHROPIC_API_KEY is needed — the CLI authenticates via the
 *   credentials file.
 *
 *   Layer 3 — Synthetic fallback: when neither OAuth nor a static key is
 *   available, any non-empty value suffices to pass the CLI's local auth
 *   check, because ANTHROPIC_BASE_URL points at this gateway and the
 *   gateway's /v1/messages handler authenticates against its OWN provider
 *   config, not the subprocess's credentials. The sentinel value "auth-ok"
 *   marks these as synthetic (never a real upstream key).
 *
 * Extracted from the inline three-way if/else in turn-runner.ts so the
 * policy lives in one place and unit tests can pin exactly when each layer
 * activates without spawning a real subprocess.
 */
export interface ResolvedClaudeAuth {
  ANTHROPIC_API_KEY?: string;
}

export async function resolveClaudeAuthEnv(runtime: { config?: { anthropic?: { apiKey?: string } } }): Promise<ResolvedClaudeAuth> {
  // Layer 1: mirror the gateway's OAuth session into the format the
  // spawned Claude Code CLI reads at startup. Refuses to clobber the
  // file with empty tokens if the gateway's own TokenSet is malformed
  // (see the long-form rationale in syncSpawnedSessionCredentials) —
  // in that case we fall through to Layers 2 and 3 below.
  const oauthResult = await syncSpawnedSessionCredentials();

  // Layer 2: static Anthropic API key from gateway config.
  const anthropicApiKey = runtime.config?.anthropic?.apiKey?.trim();
  if (anthropicApiKey) {
    return { ANTHROPIC_API_KEY: anthropicApiKey };
  }

  // Layer 3: synthetic fallback when no auth source is available.
  if (oauthResult.outcome !== "mirrored") {
    return { ANTHROPIC_API_KEY: "auth-ok" };
  }

  // OAuth mirror succeeded — the credentials file is populated and the
  // CLI will use OAuth auth mode. No ANTHROPIC_API_KEY needed.
  return {};
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
   * clobber the existing file (logged at warn); `failed` = I/O error, a
   * failed refresh attempt (e.g. a revoked refresh token), or the
   * persistence-side validity predicate refused to write. Lets
   * callers and tests tell the difference between "we deleted auth
   * intentionally" and "we couldn't mirror because the input was bad". */
  outcome: "mirrored" | "skipped" | "skipped-empty" | "failed";
}

export async function syncSpawnedSessionCredentials(): Promise<SyncSpawnedSessionCredentialsResult> {
  let tokens: TokenSet | null;
  try {
    tokens = await getValidOwnTokenSet();
  } catch (err) {
    // getValidOwnTokenSet refreshes an expiring token on demand, which
    // means a real network call to Anthropic's token endpoint can land
    // here -- and a revoked/invalid refresh token makes that call reject
    // (postToken in oauth.ts throws on a non-2xx response) rather than
    // return something isValidTokenSet can reject gracefully below. This
    // function is called both at boot (already guarded by a try/catch one
    // level up) and from startMirrorRefresh's unguarded setInterval tick
    // in runtime.ts -- an uncaught rejection there crashes the whole
    // gateway process, not just this one sync attempt, and it would do so
    // on every tick (every 30s by default) once the stored token's local
    // expiry passes, regardless of which project's agents are running.
    // Treating it as "failed" here means a dead OAuth connection degrades
    // to the existing ANTHROPIC_API_KEY=auth-ok fallback in
    // resolveClaudeAuthEnv instead of taking the process down with it.
    console.warn(`[credentials] failed to refresh OAuth tokens: ${(err as Error).message}. Reconnect via the admin OAuth panel.`);
    return { outcome: "failed" };
  }
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

