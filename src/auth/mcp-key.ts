import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { scryptHash, scryptVerify } from "./scrypt.js";
import { readJsonFile, writeJsonFile } from "../util/json-file.js";

// Kept in its own file rather than inside GatewayConfig deliberately: config
// is read/written wholesale through updateConfig()/saveConfig() and the
// whole blob backs /admin/api/state, which the admin UI polls freely. A
// bearer token that gates real spend (create_project, submit_idea -- see
// mcp/server.ts) shouldn't ride along on that same path even hashed; a
// dedicated file mirrors how the admin password itself is stored
// (admin-session.ts's AUTH_PATH), which is the codebase's own precedent for
// "a secret hash that must never appear in a generic API response."
const MCP_AUTH_PATH = process.env.GATEWAY_MCP_AUTH_PATH ?? "data/mcp-auth.json";

interface McpAuthFile {
  keyHash: string;
}

const hashKey = scryptHash;
const verifyHash = scryptVerify;

async function readAuthFile(): Promise<McpAuthFile | null> {
  return readJsonFile<McpAuthFile | null>(MCP_AUTH_PATH, null);
}

/** True once a key has been generated. Used by the admin panel to render
 *  "configured" vs. "generate a key" without ever reading the key itself. */
export async function mcpKeyConfigured(): Promise<boolean> {
  return (await readAuthFile()) !== null;
}

/** Generates a fresh key, persists only its hash, and returns the plaintext
 *  once. The caller (the admin panel) must show it to the operator now --
 *  there is no way to recover it later, matching how the admin password's
 *  own reset flow works. Overwrites any previously generated key. */
export async function generateMcpKey(): Promise<string> {
  const key = `custos_mcp_${randomBytes(24).toString("base64url")}`;
  await writeJsonFile(MCP_AUTH_PATH, { keyHash: hashKey(key) });
  return key;
}

/** Removes the stored key hash. Every request to /mcp fails closed
 *  afterward until a new key is generated. */
export async function revokeMcpKey(): Promise<void> {
  await rm(MCP_AUTH_PATH, { force: true });
}

/** Constant-time check against the stored hash. False when no key has ever
 *  been generated (fail closed, not "any bearer token works"). */
export async function verifyMcpKey(candidate: string | null | undefined): Promise<boolean> {
  if (!candidate) return false;
  const stored = await readAuthFile();
  if (!stored) return false;
  return verifyHash(candidate, stored.keyHash);
}

// Generated once, lazily, on first use -- fresh every process lifetime,
// held only in memory, never written to disk or returned from any API
// response. This is NOT the operator's own generateMcpKey() above: that
// one is shown once and hashed for external clients (a user's own Claude
// Code session on their own machine); this one authenticates custos's
// *own* spawned subprocesses (a portfolio chat's self-referential MCP
// connection, see remote/session-manager.ts) calling back into its own
// /mcp endpoint over localhost. Being ephemeral is fine and intentional
// for that use -- there is nothing outside this process that ever needs
// to remember it across a restart.
let internalKey: string | null = null;

export function getInternalMcpKey(): string {
  if (!internalKey) internalKey = `custos_mcp_internal_${randomBytes(24).toString("base64url")}`;
  return internalKey;
}
