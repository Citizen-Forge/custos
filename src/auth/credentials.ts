// OAuth token lifecycle for both the gateway itself and the `claude -p`
// subprocesses it spawns. Split under ./credentials/: store.ts (the
// gateway's own token store -- read/write/refresh against
// data/credentials.json, plus the one-time import from a locally-logged-in
// Claude Code CLI), subprocess-auth.ts (mirroring a session into the file
// format the spawned CLI reads, and resolving each subprocess's
// ANTHROPIC_API_KEY env var). subprocess-auth.ts builds on store.ts's
// token lifecycle rather than duplicating it.
export {
  loadStoredTokens,
  isValidTokenSet,
  saveTokens,
  clearTokens,
  getOAuthStatus,
  getValidAccessToken,
  type OAuthStatus,
} from "./credentials/store.js";

export {
  resolveClaudeAuthEnv,
  syncSpawnedSessionCredentials,
  type ResolvedClaudeAuth,
  type SyncSpawnedSessionCredentialsResult,
} from "./credentials/subprocess-auth.js";
