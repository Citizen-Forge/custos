import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

function hashKey(key: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(key, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyHash(key: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(key, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readAuthFile(): Promise<McpAuthFile | null> {
  try {
    return JSON.parse(await readFile(MCP_AUTH_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
  await mkdir(dirname(MCP_AUTH_PATH), { recursive: true });
  await writeFile(MCP_AUTH_PATH, JSON.stringify({ keyHash: hashKey(key) }, null, 2), "utf8");
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
