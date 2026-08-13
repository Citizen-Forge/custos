// The read-with-ENOENT-fallback / mkdir+write pair every JSON-file-backed
// store in this codebase (auth files, project/chat registries, the spend
// ledger, the curator cursor, the gateway config) reimplemented
// independently. Centralised so a change to the write shape (formatting,
// error handling) doesn't need to land in nine places to stay consistent.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Reads and JSON-parses `path`, returning `fallback` when the file
 *  doesn't exist yet. Any other read/parse error propagates. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Serializes `data` as pretty-printed JSON to `path`, creating the parent
 *  directory first if needed. */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}
