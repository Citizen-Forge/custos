// Shared types, constants, and small helpers used by both curator passes
// (extract-facts.ts and compact.ts).
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { Runtime } from "../../runtime.js";
import type { EmbeddingConfig } from "../embeddings.js";
import type { MemoryStore } from "../store.js";

export const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
export const CURSOR_PATH = process.env.GATEWAY_CURATOR_CURSOR_PATH ?? "data/curator-cursor.json";

export interface CuratorDeps {
  runtime: Runtime;
  store: MemoryStore;
  embedding: EmbeddingConfig | null;
}

export interface Cursor {
  [filename: string]: number; // lines already processed
}

export async function loadCursor(): Promise<Cursor> {
  try {
    return JSON.parse(await readFile(CURSOR_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function saveCursor(cursor: Cursor): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(CURSOR_PATH, JSON.stringify(cursor, null, 2), "utf8");
}

/**
 * Batches are sized for a small local model's context window, not for
 * efficiency. Ollama defaults to 2048 tokens, and the whole day's exchanges
 * were previously sent as one prompt -- so the transcript overflowed the
 * window, the *system prompt* at the front was the part that got truncated
 * away, and the model was left reading a conversation with no instructions.
 * It then did the natural thing and replied to it, which is why extraction
 * produced prose instead of JSON and the memory store stayed empty.
 */
const MAX_EXCHANGE_CHARS = 1200;
const MAX_BATCH_CHARS = 4000;

export function truncate(text: string): string {
  return text.length > MAX_EXCHANGE_CHARS ? `${text.slice(0, MAX_EXCHANGE_CHARS)}… [truncated]` : text;
}

export function chunk(exchanges: string[]): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const exchange of exchanges) {
    if (current.length && size + exchange.length > MAX_BATCH_CHARS) {
      batches.push(current.join("\n---\n"));
      current = [];
      size = 0;
    }
    current.push(exchange);
    size += exchange.length;
  }
  if (current.length) batches.push(current.join("\n---\n"));
  return batches;
}

/**
 * Pulls the first balanced JSON array out of a model's reply.
 *
 * Small local models routinely ignore "respond with only JSON" and wrap the
 * array in conversational prose, or answer the transcript instead of
 * cataloguing it. Insisting on a clean parse means every one of those
 * batches is silently dropped and its exchanges skipped forever, so scan
 * for the array instead. String literals are tracked so a bracket inside a
 * quoted fact can't unbalance the count.
 */
export function extractJsonArray(text: string): unknown[] | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Keep scanning -- a later array may be the real one.
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return null;
}
