// Tests for resolveClaudeAuthEnv — the three-layer auth resolution
// (OAuth mirror → static API key → synthetic "auth-ok" fallback) that gates
// every spawned `claude -p` subprocess. Isolated in its own file so its
// file-state setup doesn't interfere with the existing credentials tests.
//
// The function reads process.env.GATEWAY_CREDENTIALS_PATH (set at module load
// time) and the runtime config's anthropic.apiKey field. We set up the
// gateway credentials file on disk for Layer 1, pass a runtime config object
// for Layer 2, and assert the returned ANTHROPIC_API_KEY matches expectations.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "credentials-resolve-test-"));
process.env.GATEWAY_CREDENTIALS_PATH = join(tempDir, "store", "credentials.json");
process.env.HOME = tempDir;
process.env.USERPROFILE = tempDir;

const { resolveClaudeAuthEnv, syncSpawnedSessionCredentials } = await import("./credentials.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("Layer 2 — static API key takes priority over OAuth mirror", async () => {
  // Put valid gateway credentials on disk so syncSpawnedSessionCredentials
  // would succeed (Layer 1 available). Then pass a config with a static key
  // — Layer 2 should win because the function checks the API key first.
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  mkdirSync(join(gatewayPath, ".."), { recursive: true });
  writeFileSync(
    gatewayPath,
    JSON.stringify({
      accessToken: "sk-ant-oat01-layer1",
      refreshToken: "sk-ant-ort01-layer1",
      expiresAt: Date.now() + 60_000,
    }),
    "utf8",
  );

  const result = await resolveClaudeAuthEnv({
    config: { anthropic: { apiKey: "sk-ant-api03-static-key" } },
  });
  assert.equal(result.ANTHROPIC_API_KEY, "sk-ant-api03-static-key");
});

test("Layer 1 — OAuth mirror succeeds, no API key in config", async () => {
  // The gateway file from the previous test still has valid tokens, so
  // syncSpawnedSessionCredentials should return "mirrored". No API key in
  // config means the function returns {} (OAuth handles it).
  const result = await resolveClaudeAuthEnv({ config: {} });
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(result, {});
});

test("Layer 3 — synthetic auth-ok when neither OAuth nor API key is available", async () => {
  // Wipe the gateway file so syncSpawnedSessionCredentials returns "skipped"
  // (no tokens). No API key in config either — Layer 3 fires.
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  writeFileSync(gatewayPath, JSON.stringify({}), "utf8");

  const result = await resolveClaudeAuthEnv({ config: {} });
  assert.equal(result.ANTHROPIC_API_KEY, "auth-ok");
});

test("Layer 3 — empty gateway file (no tokens) triggers synthetic auth-ok", async () => {
  // Write a gateway file that loadStoredTokens CAN read but that has no
  // valid TokenSet. This triggers the "skipped-empty" path in
  // syncSpawnedSessionCredentials. No API key — Layer 3 fires.
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  writeFileSync(gatewayPath, JSON.stringify({ accessToken: "", refreshToken: "", expiresAt: 0 }), "utf8");

  // Confirm syncSpawnedSessionCredentials returns skipped-empty
  const oauthResult = await syncSpawnedSessionCredentials();
  assert.equal(oauthResult.outcome, "skipped-empty", "should refuse to mirror empty tokens");

  const result = await resolveClaudeAuthEnv({ config: {} });
  assert.equal(result.ANTHROPIC_API_KEY, "auth-ok");
});

test("trimmed or empty API key in config is treated as unset", async () => {
  // An API key that's all whitespace should be treated the same as unset,
  // falling through to the OAuth or synthetic layers.
  const gatewayPath = process.env.GATEWAY_CREDENTIALS_PATH!;
  // Write valid tokens for Layer 1 to succeed — we'll verify it does even
  // when config has a whitespace-only "key".
  writeFileSync(
    gatewayPath,
    JSON.stringify({
      accessToken: "sk-ant-oat01-valid",
      refreshToken: "sk-ant-ort01-valid",
      expiresAt: Date.now() + 60_000,
    }),
    "utf8",
  );

  // Whitespace-only key should be treated as unset after .trim()
  const result = await resolveClaudeAuthEnv({
    config: { anthropic: { apiKey: "   " } },
  });
  // OAuth should handle it (Layer 1)
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(result, {});
});
