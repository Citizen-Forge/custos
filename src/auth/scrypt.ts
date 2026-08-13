// Shared password/key hashing primitive. Both admin-session.ts (the
// operator's admin password) and mcp-key.ts (the MCP bearer token) hashed
// this identically but independently -- same salt length, same KDF params,
// same "salt:hash" hex encoding, same constant-time compare -- which meant
// a future change to any of those (e.g. a stronger KDF) had to be applied
// twice to stay in sync. Factored out so there's one scrypt policy for
// every secret this gateway stores as a hash rather than plaintext.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Hashes `secret` with a fresh random salt, returning `saltHex:hashHex`. */
export function scryptHash(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time check of `secret` against a `scryptHash()` output. */
export function scryptVerify(secret: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(secret, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
