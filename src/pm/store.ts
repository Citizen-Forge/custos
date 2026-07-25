import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * A tiny JSON-file-backed collection, the same shape remote/projects.ts and
 * remote/chats.ts each hand-rolled. The PM side has five of these (ideas,
 * work items, agents, agent runs, project settings) and they all mutate
 * from concurrent orchestrator ticks, so unlike the originals this one
 * serialises every mutation through a per-file promise chain -- two agents
 * finishing at the same moment would otherwise read-modify-write over each
 * other and silently drop one of the updates.
 */
export class JsonCollection<T extends { id: string }> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // A file that exists but is empty is a legitimately empty collection.
    if (!raw.trim()) return [];
    try {
      return JSON.parse(raw) as T[];
    } catch (err) {
      // Deliberately fatal rather than falling back to []: an empty array
      // here would be written straight back over the real contents by the
      // next mutation, turning a transient read problem into permanent data
      // loss. Failing the request keeps the file on disk to be recovered.
      throw new Error(`${this.path} is not valid JSON and was not overwritten: ${(err as Error).message}`);
    }
  }

  /**
   * Writes via a temporary file and an atomic rename, so a reader can only
   * ever observe the old contents or the new ones -- never a half-written
   * file. writeFile() truncates first and fills after, which leaves a window
   * where a concurrent read sees zero bytes; with several agents mutating
   * the board at once that window gets hit in practice.
   */
  private async write(rows: T[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(rows, null, 2), "utf8");
    await rename(temp, this.path);
  }

  /** Runs `fn` with exclusive access to the file: no other mutate() on this
   * collection interleaves between its read and its write. */
  private mutate<R>(fn: (rows: T[]) => Promise<R> | R): Promise<R> {
    const run = this.queue.then(async () => {
      const rows = await this.read();
      const result = await fn(rows);
      await this.write(rows);
      return result;
    });
    // Keep the chain alive even if this link rejects, or every later
    // mutation on this collection would inherit the rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<T[]> {
    return this.read();
  }

  async find(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.read()).filter(predicate);
  }

  async get(id: string): Promise<T | null> {
    return (await this.read()).find((row) => row.id === id) ?? null;
  }

  async insert(row: T): Promise<T> {
    return this.mutate((rows) => {
      rows.push(row);
      return row;
    });
  }

  /** Applies `patch` in place under the file lock and returns the updated
   * row, or null if the id is unknown. Taking a mutator rather than a
   * partial lets callers compute the new value from the current one
   * (append to history, increment a counter) without a racy read-then-write. */
  async update(id: string, patch: (row: T) => void): Promise<T | null> {
    return this.mutate((rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      patch(row);
      return row;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((rows) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    });
  }

  async removeWhere(predicate: (row: T) => boolean): Promise<number> {
    return this.mutate((rows) => {
      const keep = rows.filter((row) => !predicate(row));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return removed;
    });
  }
}

export function newId(): string {
  return randomBytes(9).toString("base64url");
}

/** Data-directory-relative path, matching how the existing stores resolve
 * their own files (GATEWAY_*_PATH env overrides, defaulting under data/). */
export function pmPath(file: string): string {
  return process.env.GATEWAY_PM_DIR ? `${process.env.GATEWAY_PM_DIR}/${file}` : `data/pm/${file}`;
}
