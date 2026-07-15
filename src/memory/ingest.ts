import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.js";

const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";

/**
 * Appends every request/response exchange to a rolling per-day log for the
 * curator to sweep later. The Messages API itself carries no stable
 * conversation/session id, so exact session boundaries aren't tracked here
 * -- the curator works off semantic content, not session grouping.
 */
export async function ingestExchange(request: AnthropicMessagesRequest, response: AnthropicMessagesResponse): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({ at: new Date().toISOString(), request, response }) + "\n";
  await appendFile(join(SESSIONS_DIR, `${day}.jsonl`), line, "utf8");
}
