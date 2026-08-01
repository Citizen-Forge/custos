// Regression tests for the auth-mirror invariant. The original bug was:
// a TokenSet with empty accessToken/refreshToken/expiresAt (but a populated
// `raw` block) could land in either data/credentials.json OR
// ~/.claude/.credentials.json via paths in src/auth/credentials.ts, and
// the spawned claude subprocess then surfaced "OAuth session expired"
// for every agent call -- including ones whose model went to non-Anthropic
// providers. These tests pin the invariant that prevents that.
// Runs against node:test; we're checking pure-logic + side-effects with
// isolated test directories.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The module-level path constants in src/auth/credentials.ts read these
// env vars at load time. Set them BEFORE the dynamic import so they land
// in temp directories we own per-run, not in the user's real ~/.claude or
// data/credentials.json. (Node's ESM honours top-level await + dynamic
// import ordering -- a static `import` at the top of the file would be
// hoisted past this setup, which is why we use await import(...).)
const tempDir = mkdtempSync(join(tmpdir(), "credentials-test-"));
process.env.GATEWAY_CREDENTIALS_PATH = join(tempDir, "store", "credentials.json");
process.env.HOME = tempDir;
process.env.USERPROFILE = tempDir;
// (Node's os.homedir() reads USERPROFILE on win32, $HOME on POSIX; we set
// both so the test is portable regardless of where it runs.)
const credentialsModule = await import("./credentials.js");
const { isValidTokenSet, saveTokens, syncSpawnedSessionCredentials, loadStoredTokens, clearTokens, getOAuthStatus } = credentialsModule;

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Placeholder anchor: the boot-time repair test sits at the END of this
// file (after `existingAfter`) so its setup writes don't interleave with
// the saveTokens-throws test above, which asserts the gateway file does
// NOT exist after a malformed save.

// isValidTokenSet must accept the >= 1 happy-path inputs (valid OAuth and
// valid API-key-style) and reject every shape that would otherwise let a
// write land a malformed TokenSet on disk.
test("isValidTokenSet truth table", () => {
  // All-missing / null / undefined: rejected.
  assert.equal(isValidTokenSet(null), false);
  assert.equal(isValidTokenSet(undefined), false);
  assert.equal(isValidTokenSet({} as never), false);

  // Each top-level field individually missing: rejected.
  assert.equal(isValidTokenSet({ refreshToken: "rt", expiresAt: 1 } as never), false, "missing accessToken");
  assert.equal(isValidTokenSet({ accessToken: "at", expiresAt: 1 } as never), false, "missing refreshToken");
  assert.equal(isValidTokenSet({ accessToken: "at", refreshToken: "rt" } as never), false, "missing expiresAt");

  // Empty strings / zero expiresAt: rejected -- the original bug shape.
  assert.equal(isValidTokenSet({ accessToken: "", refreshToken: "rt", expiresAt: 1 } as never), false, "empty accessToken");
  assert.equal(isValidTokenSet({ accessToken: "at", refreshToken: "", expiresAt: 1 } as never), false, "empty refreshToken");
  assert.equal(isValidTokenSet({ accessToken: "at", refreshToken: "rt", expiresAt: 0 } as never), false, "zero expiresAt");
  assert.equal(isValidTokenSet({ accessToken: "at", refreshToken: "rt", expiresAt: -1 } as never), false, "negative expiresAt");

  // Happy paths: accepted. `raw` block is allowed because the Claude Code
  // mirror function needs it for subscriptionType / rateLimitTier; the
  // Anthropic upstream response always carries one.
  assert.equal(
    isValidTokenSet({ accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000, raw: {} }),
    true,
    "with optional raw block",
  );
  assert.equal(
    isValidTokenSet({ accessToken: "sk-ant-oat01-...", refreshToken: "sk-ant-ort01-...", expiresAt: Date.now() + 8 * 60 * 60 * 1000 }),
    true,
    "without raw block (legacy import shape)",
  );
});

// saveTokens is the canonical entrypoint for persisting credentials to
// data/credentials.json. The bug was that an empty imported shape (via
// getValidAccessToken → importFromClaudeCode → saveTokens) silently
// overwrote valid gateway-side tokens with empty values. The fix throws
// in saveTokens so the empty-token write can't happen from either path.
test("saveTokens throws on a malformed TokenSet rather than persisting it", async () => {
  await assert.rejects(
    () => saveTokens({ accessToken: "", refreshToken: "", expiresAt: 0 } as never),
    /refusing to persist malformed/i,
  );
  // The malformed-save attempt must NOT have created the target file --
  // a partial write would be a worse outcome than the throw.
  assert.equal(existsSync(process.env.GATEWAY_CREDENTIALS_PATH!), false);
});

test("saveTokens writes a valid TokenSet", async () => {
  const valid = {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 60_000,
    raw: { scope: "user:inference user:profile" },
  };
  await saveTokens(valid);
  const onDisk = JSON.parse(readFileSync(process.env.GATEWAY_CREDENTIALS_PATH!, "utf8"));
  assert.equal(onDisk.accessToken, valid.accessToken);
  assert.equal(onDisk.refreshToken, valid.refreshToken);
  assert.equal(onDisk.expiresAt, valid.expiresAt);
  assert.deepEqual(onDisk.raw, valid.raw);

  // loadStoredTokens round-trips back to the same shape -- if the read
  // path appends or transforms the persisted shape, the gateway would
  // be the next layer to break, so pin the read invariance here too.
  const reloaded = await loadStoredTokens();
  assert.equal(reloaded?.accessToken, valid.accessToken);
});

// When getValidOwnTokenSet() returns a malformed TokenSet, the mirror
// function must NOT touch the on-disk ~/.claude/.credentials.json.
// Pre-fix, the mirror wrote the empty shape over a previously-good
// credentials file (or created one with the empty shape), producing the
// "OAuth session expired and could not be refreshed" agent failure.
//
// We force this code path by writing a SIDE-CAR TokenSet as both a valid
// Gateway-format credentials.json (so getValidOwnTokenSet has data to
// read) and a stub-but-malformed TokenSet by writing the TokenSet fields
// into the file in a way that loading them produces a real-but-empty
// TokenSet. Since the module reads os.homedir()/.claude/.credentials.json
// via importFromClaudeCode (not getValidOwnTokenSet), this test fakes
// the empty-mirror shape by writing the credentials file with all three
// fields blank and an embedded "raw" block, then calling
// syncSpawnedSessionCredentials: if the safety check didn't exists, the
// function would write the empty mirror as the gateway Claude Code file
// (replacing whatever's there with empty). The test asserts the mirror
// is REJECTED (outcome = skipped-empty) and the file on disk is NOT
// modified.
test("syncSpawnedSessionCredentials returns skipped-empty and leaves the mirror file untouched", async () => {
  // Pre-populate the Claude Code credentials path with a valid previous
  // file so we can verify it remains intact after syncSpawnedSessionCredentials
  // is called with an empty TokenSet.
  const mirrorPath = join(tempDir, ".claude", ".credentials.json");
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  const before = {
    claudeAiOauth: {
      accessToken: "previously-valid-at",
      refreshToken: "previously-valid-rt",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
  };
  writeFileSync(mirrorPath, JSON.stringify(before, null, 2), "utf8");

  // Now write a malformed credentials.json (the gateway's own store) --
  // accessToken / refreshToken blank, raw populated, AND a non-zero,
  // non-expired expiresAt. This shape was the production regression: the
  // gateway's stored TokenSet came back empty after a bad save, but the
  // expiresAt was large enough that getValidOwnTokenSet() would have
  // returned it without trying to refresh (which would have hit Anthropic
  // with an empty refresh_token and surfaced as a network error rather
  // than the silent empty-write we want this test to catch). The new
  // isValidTokenSet guard runs AFTER the load+return and refuses to
  // mirror the empty shape; that's what we're pinning here.
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  mkdirSync(join(gatewayPath, ".."), { recursive: true });
  writeFileSync(
    gatewayPath,
    JSON.stringify({ accessToken: "", refreshToken: "", expiresAt: Date.now() + 60 * 60 * 1000, raw: { scope: "user:inference user:profile" } }, null, 2),
    "utf8",
  );

  const result = await syncSpawnedSessionCredentials();
  assert.equal(result.outcome, "skipped-empty", "empty TokenSet must yield skipped-empty, not a clobber");

  const after = JSON.parse(readFileSync(mirrorPath, "utf8"));
  assert.equal(after.claudeAiOauth.accessToken, before.claudeAiOauth.accessToken, "previously-valid accessToken preserved");
  assert.equal(after.claudeAiOauth.refreshToken, before.claudeAiOauth.refreshToken, "previously-valid refreshToken preserved");
});

// The boot-time repair path called from src/index.ts main(). The
// invariant: a valid TokenSet on disk must always overwrite a stale
// (empty-shape) mirror with valid content, so the first claude
// subprocess the container spawns reads a meaningful credentials file
// instead of inheriting whatever bad shape a previous boot wrote (or
// what the bind-mounted ./data/claude-home volume carries forward).
// Pre-fix, this code path silently wrote the empty shape on top of the
// valid input -- the production bug-shape this suite is built to pin.
// Post-fix, `syncSpawnedSessionCredentials` writes valid content with
// the correct scope + refreshTokenExpiresAt, which Claude Code's
// local-login check requires beyond the three top-level fields.
test("syncSpawnedSessionCredentials writes a valid mirror when input is valid even if the on-disk mirror was empty", async () => {
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  mkdirSync(join(gatewayPath, ".."), { recursive: true });
  const validTokens = {
    accessToken: "sk-ant-oat01-bootstrap",
    refreshToken: "sk-ant-ort01-bootstrap",
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    raw: { scope: "user:inference user:profile", refresh_token_expires_in: 2109600 },
  };
  writeFileSync(gatewayPath, JSON.stringify(validTokens, null, 2), "utf8");

  const mirrorPath = join(tempDir, ".claude", ".credentials.json");
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  const emptyPreExisting = { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } };
  writeFileSync(mirrorPath, JSON.stringify(emptyPreExisting, null, 2), "utf8");

  const result = await syncSpawnedSessionCredentials();
  assert.equal(result.outcome, "mirrored", "valid input should yield outcome=mirrored");

  const after = JSON.parse(readFileSync(mirrorPath, "utf8"));
  assert.equal(after.claudeAiOauth.accessToken, validTokens.accessToken);
  assert.equal(after.claudeAiOauth.refreshToken, validTokens.refreshToken);
  assert.equal(after.claudeAiOauth.expiresAt, validTokens.expiresAt);
  assert.deepEqual(after.claudeAiOauth.scopes, ["user:inference", "user:profile"]);
  assert.equal(
    typeof after.claudeAiOauth.refreshTokenExpiresAt,
    "number",
    "mirror must carry the refreshTokenExpiresAt derived from raw.refresh_token_expires_in (Claude Code's local-login check requires it)",
  );
});

// The admin panel's "Disconnect OAuth" bug: clearTokens() previously only
// removed the gateway's own store, leaving a stale ~/.claude/.credentials.json
// mirror in place -- since that mirror is only ever written as a projection
// of Custos's own tokens (never an independent host login in this
// deployment), the very next getOAuthStatus() call fell back to
// importFromClaudeCode(), found the still-valid mirror, and reported
// connected again with source "claude-code". Disconnect appeared to
// silently undo itself. Pinning: after clearTokens(), both files must be
// gone and getOAuthStatus() must report disconnected.
test("clearTokens removes both the gateway store and the Claude Code mirror", async () => {
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  mkdirSync(join(gatewayPath, ".."), { recursive: true });
  const validTokens = {
    accessToken: "sk-ant-oat01-disconnect-test",
    refreshToken: "sk-ant-ort01-disconnect-test",
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  };
  writeFileSync(gatewayPath, JSON.stringify(validTokens, null, 2), "utf8");

  // Simulate the mirror the periodic sync would have already written from
  // this same TokenSet before the user ever clicks Disconnect.
  const mirrorPath = join(tempDir, ".claude", ".credentials.json");
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  writeFileSync(
    mirrorPath,
    JSON.stringify({ claudeAiOauth: { accessToken: validTokens.accessToken, refreshToken: validTokens.refreshToken, expiresAt: validTokens.expiresAt } }, null, 2),
    "utf8",
  );

  const beforeStatus = await getOAuthStatus();
  assert.equal(beforeStatus.connected, true, "sanity check: connected before disconnect");

  await clearTokens();

  assert.equal(existsSync(gatewayPath), false, "gateway store removed");
  assert.equal(existsSync(mirrorPath), false, "Claude Code mirror removed");

  const afterStatus = await getOAuthStatus();
  assert.equal(afterStatus.connected, false, "must not fall back to the now-removed mirror");
});
