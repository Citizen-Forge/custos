import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const AUTH_PATH = process.env.GATEWAY_AUTH_PATH ?? "data/auth.json";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = "custos_session";

interface AuthFile {
  passwordHash: string;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readAuthFile(): Promise<AuthFile | null> {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeAuthFile(auth: AuthFile): Promise<void> {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(auth, null, 2), "utf8");
}

/**
 * Runs once at startup. If no password has ever been set, seeds one from
 * ADMIN_PASSWORD if provided, otherwise generates a random one and prints
 * it once -- this is the only time it's ever recoverable in plaintext.
 * Once data/auth.json exists, the env var is ignored (same "file wins
 * once set" pattern as the Anthropic API key) so a stale env var can't
 * silently undo a password someone changed via the admin UI.
 */
export async function ensureAdminPassword(): Promise<void> {
  if (await readAuthFile()) return;

  const password = process.env.ADMIN_PASSWORD ?? randomBytes(16).toString("base64url");
  await writeAuthFile({ passwordHash: hashPassword(password) });

  if (!process.env.ADMIN_PASSWORD) {
    console.log("=".repeat(60));
    console.log(`Generated admin password: ${password}`);
    console.log("Save this now -- it will not be shown again. Change it");
    console.log("from the admin UI after logging in, or set ADMIN_PASSWORD");
    console.log("before first boot to choose your own.");
    console.log("=".repeat(60));
  }
}

export async function checkPassword(password: string): Promise<boolean> {
  const auth = await readAuthFile();
  if (!auth) return false;
  return verifyPassword(password, auth.passwordHash);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const auth = await readAuthFile();
  if (!auth || !verifyPassword(currentPassword, auth.passwordHash)) return false;
  await writeAuthFile({ passwordHash: hashPassword(newPassword) });
  return true;
}

interface SessionRecord {
  createdAt: number;
}

/** In-memory only -- a restart logs everyone out. Acceptable for a
 * single-operator self-hosted tool; sessions are cheap to re-establish. */
class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  create(): string {
    this.sweep();
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { createdAt: Date.now() });
    return id;
  }

  isValid(id: string | undefined): boolean {
    if (!id) return false;
    const record = this.sessions.get(id);
    if (!record) return false;
    if (Date.now() - record.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, record] of this.sessions) {
      if (record.createdAt < cutoff) this.sessions.delete(id);
    }
  }
}

export const sessions = new SessionStore();
