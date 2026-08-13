import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * The exact wire-format request/response for every dispatch to an
 * OpenAI-compatible provider (local Ollama, Groq, OpenRouter, etc --
 * wherever request/response logging is wired in, see
 * openai-compatible.ts). Built for one specific purpose: when a run
 * fails in a way that isn't obviously a code bug (the model hallucinates,
 * announces intent and never calls a tool, or the CLI reports a generic
 * "ended in an error"), this is what lets someone pull the *exact* bytes
 * that were sent and replay them against a different model to see if the
 * failure is model-specific -- without hand-reconstructing the prompt
 * from a Claude Code session transcript, which only has the higher-level
 * conversation, not the actual wire request (tool schemas, exact system
 * prompt placement, sampling params) a model received.
 *
 * One JSONL file per calendar day (data/request-log/YYYY-MM-DD.jsonl,
 * matching memory/curator.ts's dated-session-file convention), pruned
 * past GATEWAY_REQUEST_LOG_RETENTION_DAYS (default 7) so a long-running
 * gateway doesn't accumulate this forever -- a request/response pair
 * here can be tens of KB each, and every conversational round-trip in a
 * tool-heavy engineer run is a separate entry.
 */

export interface RequestLogContext {
  requestId?: string;
  projectId?: string;
  projectName?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  workItemId?: string | null;
  tag?: string;
}

export interface RequestLogEntry {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  durationMs: number;
  /** Upstream HTTP status, or null when the request never got a response
   *  (a network-level failure -- see `error`). */
  status: number | null;
  /** Set only when the request/fetch itself threw (unreachable, aborted).
   *  A non-2xx HTTP response is NOT an error here -- `status` and
   *  `response` already carry that, since the upstream's rejection body
   *  is exactly the kind of thing worth reproducing too. */
  error: string | null;
  /** The exact JSON body sent to `${baseUrl}/chat/completions` -- OpenAI
   *  wire format, already model-overridden and size-fitted, i.e. the
   *  literal bytes the upstream received. Never truncated: the whole
   *  point is reproducing this exactly. */
  request: unknown;
  /** Raw response text. For a non-streaming call, the JSON body as
   *  received. For a streaming call, the concatenated raw SSE frames
   *  (`data: {...}\n\n` chunks) before any Anthropic-format translation --
   *  this is what a replay script would need to parse, not our
   *  already-translated internal representation. */
  response: string;
  context: RequestLogContext;
}

const LOG_DIR = process.env.GATEWAY_REQUEST_LOG_DIR ?? "data/request-log";
const RETENTION_DAYS = Number(process.env.GATEWAY_REQUEST_LOG_RETENTION_DAYS ?? 7);

function todayFile(): string {
  return join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

let counter = 0;
function freshId(): string {
  counter = (counter + 1) & 0xffffffff;
  return `rl-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Re-checked once per calendar day (not on every write) -- pruning is a
 *  directory listing plus a handful of unlinks, cheap but pointless to
 *  repeat on every one of potentially hundreds of writes in a day. */
let prunedForDate: string | null = null;

async function pruneOldFiles(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (prunedForDate === today) return;
  prunedForDate = today;
  try {
    const files = await readdir(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (!match) continue;
      if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
        await unlink(join(LOG_DIR, file)).catch(() => {});
      }
    }
  } catch {
    // Most likely ENOENT -- the directory doesn't exist until the first
    // write's mkdir creates it. Either way, skip this cycle; it'll retry
    // tomorrow, and a missed prune just means one extra day of files.
  }
}

/** Fire-and-forget: a logging failure (disk full, permissions) must never
 *  affect the actual dispatch it's describing. */
export function logRequest(entry: Omit<RequestLogEntry, "id" | "timestamp">): void {
  void (async () => {
    void pruneOldFiles();
    const full: RequestLogEntry = { id: freshId(), timestamp: new Date().toISOString(), ...entry };
    try {
      const path = todayFile();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
    } catch (err) {
      console.error(`[request-log] failed to write: ${(err as Error).message}`);
    }
  })();
}
