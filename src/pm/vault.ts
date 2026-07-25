import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { JsonCollection, newId, pmPath } from "./store.js";

const KEY_PATH = process.env.GATEWAY_VAULT_KEY_PATH ?? "data/vault.key";
const ALGORITHM = "aes-256-gcm";

/** Env-var-shaped names only: these are injected into agent processes as
 * environment variables, so anything else would either be silently dropped
 * or, worse, mangle the environment of every run. */
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export interface StoredSecret {
  id: string;
  /** Environment variable name, e.g. GITHUB_TOKEN. Unique within a scope. */
  name: string;
  description: string;
  /** null = available to every project; otherwise scoped to that project. */
  projectId: string | null;
  /** Whether this value is injected into autonomous agent runs. Off means
   * Custos itself can use it but agents never see it -- an agent with a
   * value in its environment can print it, and there is no way to take that
   * back, so exposure is an explicit per-secret decision. */
  exposeToAgents: boolean;
  /** Additionally wire this as git/gh credentials so agents can push and
   * open pull requests without the token ever appearing in a remote URL. */
  useForGit: boolean;
  iv: string;
  tag: string;
  ciphertext: string;
  /** Last four characters of the plaintext, for recognising which token is
   * which without revealing it. */
  hint: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

/** What the API and UI are allowed to see: everything except the value. */
export type SecretSummary = Omit<StoredSecret, "iv" | "tag" | "ciphertext">;

const secrets = new JsonCollection<StoredSecret>(pmPath("vault.json"));

let cachedKey: Buffer | null = null;

/**
 * The master key. Prefer CUSTOS_VAULT_KEY (32 bytes, base64 or hex) supplied
 * by the operator -- that keeps the key out of the data directory entirely,
 * so a backup or a stray copy of data/ is useless on its own.
 *
 * Falling back to a generated key file is a deliberate convenience: it means
 * the vault works out of the box rather than tempting anyone back to plain
 * environment variables. Be clear about what it does and doesn't buy you --
 * with the key file sitting next to the ciphertext, this protects against
 * casual exposure (a leaked backup of vault.json, a screenshot, a file
 * accidentally committed), not against someone who has the data directory.
 */
async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.CUSTOS_VAULT_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, fromEnv.length === 64 ? "hex" : "base64");
    if (buf.length !== 32) throw new Error("CUSTOS_VAULT_KEY must decode to exactly 32 bytes");
    cachedKey = buf;
    return buf;
  }

  try {
    const existing = Buffer.from((await readFile(KEY_PATH, "utf8")).trim(), "base64");
    if (existing.length === 32) {
      cachedKey = existing;
      return existing;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const generated = randomBytes(32);
  await mkdir(dirname(KEY_PATH), { recursive: true });
  await writeFile(KEY_PATH, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  await chmod(KEY_PATH, 0o600).catch(() => undefined);
  cachedKey = generated;
  return generated;
}

async function encrypt(plaintext: string): Promise<Pick<StoredSecret, "iv" | "tag" | "ciphertext">> {
  const key = await getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

async function decrypt(secret: StoredSecret): Promise<string> {
  const key = await getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function summarize(secret: StoredSecret): SecretSummary {
  const { iv: _iv, tag: _tag, ciphertext: _ciphertext, ...rest } = secret;
  return rest;
}

export async function listSecrets(projectId?: string): Promise<SecretSummary[]> {
  const rows = await secrets.list();
  return rows
    .filter((row) => !projectId || row.projectId === null || row.projectId === projectId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(summarize);
}

export interface CreateSecretInput {
  name: string;
  value: string;
  description?: string;
  projectId?: string | null;
  exposeToAgents?: boolean;
  useForGit?: boolean;
}

export async function createSecret(input: CreateSecretInput): Promise<SecretSummary> {
  const name = input.name.trim().toUpperCase();
  if (!NAME_PATTERN.test(name)) {
    throw new Error("name must look like an environment variable: A-Z, 0-9 and underscore, not starting with a digit");
  }
  if (!input.value) throw new Error("value is required");

  const projectId = input.projectId ?? null;
  const clash = (await secrets.list()).find((row) => row.name === name && row.projectId === projectId);
  if (clash) throw new Error(`a secret named ${name} already exists in this scope`);

  const now = Date.now();
  const created = await secrets.insert({
    id: newId(),
    name,
    description: input.description ?? "",
    projectId,
    exposeToAgents: input.exposeToAgents ?? true,
    useForGit: input.useForGit ?? false,
    ...(await encrypt(input.value)),
    hint: input.value.slice(-4),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });
  invalidate();
  return summarize(created);
}

export interface UpdateSecretInput {
  value?: string;
  description?: string;
  exposeToAgents?: boolean;
  useForGit?: boolean;
}

export async function updateSecret(id: string, patch: UpdateSecretInput): Promise<SecretSummary | null> {
  const encrypted = patch.value ? await encrypt(patch.value) : null;
  const updated = await secrets.update(id, (secret) => {
    if (encrypted && patch.value) {
      Object.assign(secret, encrypted);
      secret.hint = patch.value.slice(-4);
    }
    if (patch.description !== undefined) secret.description = patch.description;
    if (patch.exposeToAgents !== undefined) secret.exposeToAgents = patch.exposeToAgents;
    if (patch.useForGit !== undefined) secret.useForGit = patch.useForGit;
    secret.updatedAt = Date.now();
  });
  invalidate();
  return updated ? summarize(updated) : null;
}

export async function deleteSecret(id: string): Promise<boolean> {
  const removed = await secrets.remove(id);
  invalidate();
  return removed;
}

export async function deleteProjectSecrets(projectId: string): Promise<number> {
  const removed = await secrets.removeWhere((row) => row.projectId === projectId);
  invalidate();
  return removed;
}

// ------------------------------------------------------------------ resolution

/** Decrypted values, cached because redaction runs over every line of every
 * agent's output and re-deriving the key each time would be absurd. Dropped
 * whenever the vault changes. */
let cache: { at: number; values: Map<string, string> } | null = null;

function invalidate(): void {
  cache = null;
}

async function allValues(): Promise<Map<string, string>> {
  if (cache) return cache.values;
  const values = new Map<string, string>();
  for (const secret of await secrets.list()) {
    try {
      values.set(secret.id, await decrypt(secret));
    } catch {
      // A secret encrypted under a different key (the key file was replaced)
      // can't be recovered; skip it rather than failing every agent run.
    }
  }
  cache = { at: Date.now(), values };
  return values;
}

/**
 * The environment a project's agent runs get. Project-scoped secrets win
 * over a global secret of the same name, so a project can override a shared
 * default without the global one having to be deleted.
 */
export async function resolveAgentEnv(projectId: string): Promise<Record<string, string>> {
  const values = await allValues();
  const rows = (await secrets.list()).filter((row) => row.exposeToAgents && (row.projectId === null || row.projectId === projectId));
  // Globals first so project-scoped entries overwrite them.
  rows.sort((a, b) => Number(a.projectId !== null) - Number(b.projectId !== null));

  const env: Record<string, string> = {};
  const used: string[] = [];
  for (const row of rows) {
    const value = values.get(row.id);
    if (value === undefined) continue;
    env[row.name] = value;
    used.push(row.id);
    // A token wired for git is also handed to the GitHub CLI, which looks
    // for GH_TOKEN -- otherwise an agent would have credentials for `git`
    // but not for `gh pr create`, which is half of what it needs.
    if (row.useForGit) {
      env.GH_TOKEN ??= value;
      env.GIT_TERMINAL_PROMPT = "0";
    }
  }

  for (const id of used) void secrets.update(id, (row) => void (row.lastUsedAt = Date.now()));
  return env;
}

/**
 * Replaces every stored secret value found in `text` with a placeholder.
 *
 * Agent output is persisted to the board as comments and run summaries and
 * rendered in the UI, so a single `echo $GITHUB_TOKEN` in a transcript would
 * write a live credential into the project's permanent record. Redaction on
 * the way in is the only point where that can still be stopped -- once it's
 * in a comment it's been distributed.
 */
export async function redactSecrets(text: string): Promise<string> {
  if (!text) return text;
  const values = await allValues();
  let redacted = text;
  // Longest first: a short secret that happens to be a substring of a longer
  // one must not partially mask it and leave the rest readable.
  for (const value of [...values.values()].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(value).join("[redacted secret]");
  }
  return redacted;
}

/** True when the vault holds a git-wired token for this project, so callers
 * can tell an agent whether pushing is actually going to work. */
export async function hasGitCredentials(projectId: string): Promise<boolean> {
  const rows = await secrets.list();
  return rows.some((row) => row.useForGit && row.exposeToAgents && (row.projectId === null || row.projectId === projectId));
}
