import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../runtime.js";
import type { EmbeddingConfig } from "./embeddings.js";
import { embed } from "./embeddings.js";
import { MemoryStore } from "./store.js";
import { getGlobalAgent } from "../pm/global-agents.js";
import { primaryPick } from "../pm/agents.js";


const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
const CURSOR_PATH = process.env.GATEWAY_CURATOR_CURSOR_PATH ?? "data/curator-cursor.json";

const EXTRACTION_SYSTEM_PROMPT = `You curate long-term memory for a coding assistant from raw conversation exchanges. Extract only durable, semantically useful facts worth recalling in future unrelated sessions: user preferences, project decisions, recurring context, corrections the user gave. Ignore one-off task details, code diffs, and anything only useful within the current conversation.

Respond with ONLY a JSON array, each item: {"topic": "short label", "text": "the fact, self-contained and understandable out of context"}. Return [] if nothing durable is worth keeping.

Output rules, which matter more than being helpful:
- Your entire reply must be the JSON array and nothing else. No greeting, no explanation, no commentary on the conversation, no markdown fence.
- Do not reply to the conversation you are shown. You are not a participant in it — you are reading a transcript and cataloguing facts from it.
- If there is nothing worth keeping, the correct and complete reply is exactly: []`;

/** System prompt for conversation compaction. Unlike fact extraction (which
 *  isolates individual durable facts), compaction produces a single
 *  structured user message that replaces the oldest exchanges. The summary
 *  must preserve every decision, user preference, and architectural choice
 *  so the conversation can continue without the compacted context going
 *  silent. */
const COMPACTION_SYSTEM_PROMPT = `You are a conversation compaction assistant. Given the oldest exchanges from a long-running chat, produce a concise structured summary that preserves every decision, fact, user preference, architectural choice, and ongoing task. The summary will replace these exchanges so the conversation can continue without hitting size limits.

Write a single user message that a new participant in the conversation could read to get up to speed. Use plain text, keep it factual and complete. Include:
- Project goals and constraints
- Key decisions and their rationale
- User preferences (tool choices, coding style, review depth)
- Open issues / in-progress work
- Architecture or design choices

Your entire response must be the user message text and nothing else. No greeting, no explanation, no markdown fences.`;

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

function truncate(text: string): string {
  return text.length > MAX_EXCHANGE_CHARS ? `${text.slice(0, MAX_EXCHANGE_CHARS)}… [truncated]` : text;
}

function chunk(exchanges: string[]): string[] {
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

/** Extracts and stores facts for one batch. Returns how many were stored.
 *
 * The model's choice is owned by the global agent with
 * systemRole === "memoryCurator" (see pm/global-agents.ts). The curator
 * dispatches through `runtime.completeViaProvider` — single-entry
 * inline chain routed via the GlobalQueue — which keeps the curator on
 * the same cooldown / breaker / RPM / concurrency surface as chat
 * traffic rather than bypassing it with a bare provider call. The
 * `"background"` priority tag is what puts the curator's queued
 * requests behind any in-flight chat traffic on a saturated local
 * Ollama — chat shouldn't have to wait behind a curator pass. */
async function curateBatch(deps: CuratorDeps, file: string, batchText: string): Promise<number> {
  const agent = await getGlobalAgent("memoryCurator");
  if (!agent) {
    // No global agent configured — skip rather than fabricate a default,
    // because the user-facing surface for setting one is the Admin UI's
    // Global Services panel and skipping silently is what makes that
    // gap visible.
    console.warn("curator: no global agent with systemRole \"memoryCurator\"; skipping batch");
    return 0;
  }
  // Resolve the dispatch target from the runtime's primaryPick (no
  // router involved post-router-drop). primaryPick walks the agent's
  // fallbackSet against ProviderStateMap and returns the first
  // provider+model with a live slot. The runtime holds the merged
  // config (config + fileConfig) by contract — `Runtime.config` is the
  // public source of truth. Falling back to a skip-on-unconfigured-pick
  // means a stale disk value (e.g. an agent whose fallbackSet points at
  // a removed provider) surfaces as a clean warning rather than a
  // silent wrong-provider dispatch.
  const config = deps.runtime.config;
  const pick = primaryPick(agent, config);
  if (!pick) {
    console.warn(`curator: no primary pick for global agent "${agent.name}" (fallbackSet="${agent.fallbackSet ?? "<unset>"}"); skipping batch`);
    return 0;
  }
  const res = await deps.runtime.completeViaProvider(
    pick.providerKey,
    pick.model,
    {
      model: pick.model,
      system: EXTRACTION_SYSTEM_PROMPT,
      max_tokens: 1000,
      messages: [{ role: "user", content: batchText }],
    },
    { priority: "background" },
    { fallbackSet: agent.fallbackSet ?? undefined, projectId: undefined, agentId: agent.id, agentName: agent.name, role: "memoryCurator" },
  );
  const responseText = await new Response(res.body).text();

  let contentText = responseText;
  try {
    const json = JSON.parse(responseText);
    contentText = json.content?.[0]?.text ?? responseText;
  } catch {
    // Not an Anthropic-shaped envelope; treat the whole body as the text.
  }

  const parsed = extractJsonArray(contentText);
  if (!parsed) {
    console.warn("curator: no JSON array in extraction output; first 200 chars:", contentText.slice(0, 200).replace(/\s+/g, " "));
    return 0;
  }

  let stored = 0;
  for (const fact of parsed) {
    const text = (fact as { text?: unknown })?.text;
    const topic = (fact as { topic?: unknown })?.topic;
    if (typeof text !== "string" || !text.trim()) continue;
    // No embeddings global agent configured: skip storing this fact
    // rather than crashing. The admin UI's Global Services panel is the
    // place to set one up; skipping silently is what makes the gap
    // visible during the same session the user sees the empty memory store.
    if (!deps.embedding) continue;
    try {
      const vector = await embed(deps.embedding, text);
      await deps.store.upsert(
        { text, topic: typeof topic === "string" ? topic : "", sourceSessionId: file, createdAt: new Date().toISOString() },
        vector,
      );
      stored++;
    } catch (err) {
      // One unembeddable fact shouldn't abort the pass and strand every
      // later file behind it -- but it must not pass unremarked either.
      console.warn(`curator: failed to store a fact (${(err as Error).message})`);
    }
  }
  return stored;
}

interface Cursor {
  [filename: string]: number; // lines already processed
}

async function loadCursor(): Promise<Cursor> {
  try {
    return JSON.parse(await readFile(CURSOR_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function saveCursor(cursor: Cursor): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(CURSOR_PATH, JSON.stringify(cursor, null, 2), "utf8");
}

export interface CuratorDeps {
  runtime: Runtime;
  store: MemoryStore;
  embedding: EmbeddingConfig | null;
}

export async function runCuratorPass(deps: CuratorDeps): Promise<number> {
  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const cursor = await loadCursor();
  let factsStored = 0;

  for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
    const content = await readFile(join(SESSIONS_DIR, file), "utf8");
    const lines = content.split("\n").filter(Boolean);
    const alreadyProcessed = cursor[file] ?? 0;
    const newLines = lines.slice(alreadyProcessed);
    if (newLines.length === 0) continue;

    const exchanges = newLines.map((l) => {
      const { request, response } = JSON.parse(l);
      const userText = request.messages?.at(-1)?.content ?? "";
      const assistantText = response.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
      const user = typeof userText === "string" ? userText : JSON.stringify(userText);
      return `USER: ${truncate(user)}\nASSISTANT: ${truncate(assistantText)}`;
    });

    for (const batchText of chunk(exchanges)) {
      factsStored += await curateBatch(deps, file, batchText);
    }

    cursor[file] = lines.length;
  }

  await saveCursor(cursor);
  return factsStored;
}

/** Extract text from a message content value that may be a plain string,
 *  an array of content blocks (the format Claude Code's session files use,
 *  and what Anthropic's Messages API returns for multi-block responses),
 *  or any other shape.  Returns the concatenated text or null when nothing
 *  text-shaped is present. */
export function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_result" && typeof block.content === "string") {
          texts.push(block.content);
        } else if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner && typeof inner === "object" && inner.type === "text" && typeof inner.text === "string") {
              texts.push(inner.text);
            }
          }
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/** Scans session files and compacts the oldest half of exchanges when the
 *  estimated dispatch size exceeds the compaction threshold (60 % of the
 *  smallest `maxRequestBytes` across all configured providers). The oldest
 *  exchanges are replaced with a structured summary produced by the
 *  memoryCurator global agent, preventing conversations from growing to
 *  the point where pre-emptive truncation drops context on every dispatch.
 *
 *  Runs BEFORE `runCuratorPass` in the same interval so the curator reads
 *  the compacted file rather than the pre-compaction original. The cursor
 *  is updated after compaction so the next curator pass does not re-process
 *  the compacted summary as new content.
 *
 *  Returns the number of session files compacted this pass (not the number
 *  of exchanges — an operator seeing `compact: 3` knows three sessions were
 *  rewritten, which is the actionable signal). Returns 0 when no provider
 *  has a `maxRequestBytes` cap (compaction not needed) or when all sessions
 *  are under the compaction threshold. */
export async function runCompactPass(deps: CuratorDeps): Promise<number> {
  // Find the smallest maxRequestBytes across all providers.
  const config = deps.runtime.config;
  let maxRequestBytes: number | undefined;
  for (const def of Object.values(config.providers ?? {})) {
    if (def.maxRequestBytes !== undefined) {
      if (maxRequestBytes === undefined || def.maxRequestBytes < maxRequestBytes) {
        maxRequestBytes = def.maxRequestBytes;
      }
    }
  }
  // Also check legacy instances in case no new-shape provider has a cap.
  for (const instance of Object.values(config.openaiCompatibleInstances ?? {})) {
    if (instance.maxRequestBytes !== undefined) {
      if (maxRequestBytes === undefined || instance.maxRequestBytes < maxRequestBytes) {
        maxRequestBytes = instance.maxRequestBytes;
      }
    }
  }
  if (maxRequestBytes === undefined) {
    return 0; // No provider has a request size cap; no compaction needed.
  }

  const compactThreshold = maxRequestBytes * 0.6;

  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const agent = await getGlobalAgent("memoryCurator");
  if (!agent) {
    console.warn("compact: no global agent with systemRole \"memoryCurator\"; skipping pass");
    return 0;
  }
  const pick = primaryPick(agent, config);
  if (!pick) {
    console.warn(`compact: no primary pick for global agent "${agent.name}" (fallbackSet="${agent.fallbackSet ?? "<unset>"}"); skipping pass`);
    return 0;
  }

  const cursor = await loadCursor();
  let compacted = 0;

  for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
    const filePath = join(SESSIONS_DIR, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (e) {
      console.warn(`compact: skip unreadable file ${file}: ${(e as Error).message}`);
      continue;
    }
    const lines = content.split("\n").filter(Boolean);
    if (lines.length < 4) continue; // Too few lines to compact (< 2 turns).

    // Estimate dispatch size by accumulating the byte length of each
    // exchange's text incrementally, WITHOUT building the full combined
    // messages array in memory.  For a 125 MB session file with 800+ lines
    // the combined structure + JSON.stringify can push Node past its heap
    // limit and OOM the process, which is worse than a slightly-noisy
    // estimate.
    //
    // We append each exchange's text into a running estimate using the
    // JSON-overhead formula that matches what the provider would see:
    // \`{"messages":[$content]}\` where $content is the serialised array.
    // Each entry adds \`{"role":"...","content":"$escaped"},\` so we can
    // approximate bytes = overhead + sum(content.length).  This is not an
    // exact byte count (escaping, whitespace, key length vary) but it is
    // close enough to decide "does this exceed 60 % of 32 MB" without
    // constructing the payload.
    let estimateBytes = 0;
    let messageCount = 0;
    let hasTrailingAssistant = false;
    // Per-line static overhead: tools definitions and system prompt are
    // carried once per dispatch, not per-exchange.  We track the last
    // parsed value and add it after the accumulation loop.  The session
    // files store these on every line (redundant), and counting them
    // once per exchange would massively overcount (99 KB tools × 803
    // lines = ~79 MB for a conversation whose actual dispatch is ~160 KB).
    let staticToolsBytes = 0;
    let staticSystemBytes = 0;
    for (const line of lines) {
      let parsed: { request?: { messages?: Array<{ role: string; content: unknown }>; tools?: unknown; system?: unknown }; response?: { content?: Array<{ type: string; text?: string }> } };
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(`compact: skipping malformed line in ${file}`);
        continue;
      }
      // Track static overhead from the last parsed line (tools + system
      // are the same across all lines for a given session).
      if (Array.isArray(parsed.request?.tools)) {
        staticToolsBytes = Buffer.byteLength(JSON.stringify(parsed.request.tools), "utf8");
      }
      if (parsed.request?.system !== undefined) {
        staticSystemBytes = Buffer.byteLength(JSON.stringify(parsed.request.system), "utf8");
      }
      const msg = parsed.request?.messages?.at?.(-1);
      if (msg) {
        const text = extractContentText(msg.content);
        if (text) {
          if (msg.role === "system" && messageCount === 0) {
            // {"role":"system","content":"$text"} – key overhead ~30 B
            estimateBytes += 30 + Buffer.byteLength(text, "utf8");
            messageCount++;
          } else if (msg.role === "user") {
            // {"role":"user","content":"$text"}
            estimateBytes += 28 + Buffer.byteLength(text, "utf8");
            messageCount++;
            hasTrailingAssistant = false;
          }
        }
      }
      const assistantBlock = parsed.response?.content?.find((b) => b.type === "text");
      if (assistantBlock?.text) {
        estimateBytes += 34 + Buffer.byteLength(assistantBlock.text, "utf8");
        messageCount++;
        hasTrailingAssistant = true;
      }
    }
    // Remove the trailing assistant estimate if the last exchange has no
    // response yet (in-flight turns).
    if (hasTrailingAssistant) {
      // Subtract the last assistant entry's contribution.  We don't store
      // the individual contributions, so re-parse the last line.  This is
      // a single-line parse, not O(N) — negligible cost.
      const lastLine = lines[lines.length - 1];
      try {
        const lastParsed = JSON.parse(lastLine);
        const lastBlock = lastParsed.response?.content?.find((b: { type: string; text?: string }) => b.type === "text");
        if (lastBlock?.text) {
          estimateBytes -= 34 + Buffer.byteLength(lastBlock.text, "utf8");
          messageCount--;
        }
      } catch { /* best-effort */ }
    }
    // Wrapper overhead: {"messages":[$entries]} adds 15 B ({"messages":[
    // = 13 B, ]} = 2 B) plus one comma between every pair of entries
    // (messageCount - 1 at 1 B each).
    let bytes = estimateBytes + 15 + (messageCount > 0 ? messageCount - 1 : 0);

    // Add static overhead (tools + system) which is carried once per
    // dispatch but was not counted in the per-exchange loop.  Previous
    // analysis of the 125 MB 2026-07-25 session file showed these
    // account for ~135 KB of every 160 KB line — the estimation was
    // missing ~85% of the actual dispatch size, causing compaction to
    // skip files that were 6x over the threshold.
    bytes += staticToolsBytes;
    bytes += staticSystemBytes;

    if (bytes > compactThreshold * 0.5 && bytes <= compactThreshold) {
      console.log(`[compact] ${file}: ~${(bytes / 1024 / 1024).toFixed(1)} MB estimated vs ${(compactThreshold / 1024 / 1024).toFixed(1)} MB threshold; skipping`);
    }

    if (bytes <= compactThreshold) {
      // Debug-visible so an operator wondering "why isn't compaction
      // firing on this 125 MB session" can see the estimate in the
      // container logs without deploying instrumentation.
      if (bytes > compactThreshold * 0.5) {
        console.log(`[compact] ${file}: ${(bytes / 1024 / 1024).toFixed(1)} MB estimated vs ${(compactThreshold / 1024 / 1024).toFixed(1)} MB threshold; skipping`);
      }
      continue;
    }

    // Compact the oldest half of exchanges.
    const compactCount = Math.max(1, Math.floor(lines.length / 2));
    const oldLines = lines.slice(0, compactCount);
    const keepLines = lines.slice(compactCount);

    // Build exchange text for the compaction agent.
    const exchanges = oldLines.map((l) => {
      const { request, response } = JSON.parse(l);
      const userText = request.messages?.at(-1)?.content ?? "";
      const assistantText = response.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
      const user = typeof userText === "string" ? userText : JSON.stringify(userText);
      return `USER: ${truncate(user)}\nASSISTANT: ${truncate(assistantText)}`;
    });
    const batchText = exchanges.join("\n---\n");

    const res = await deps.runtime.completeViaProvider(
      pick.providerKey,
      pick.model,
      {
        model: pick.model,
        system: COMPACTION_SYSTEM_PROMPT,
        max_tokens: 2000,
        messages: [{ role: "user", content: batchText }],
      },
      { priority: "background" },
      { fallbackSet: agent.fallbackSet ?? undefined, projectId: undefined, agentId: agent.id, agentName: agent.name, role: "memoryCurator" },
    );

    const responseText = await new Response(res.body).text();
    let summary = responseText;
    try {
      const json = JSON.parse(responseText);
      summary = json.content?.[0]?.text ?? responseText;
    } catch {
      // Not an Anthropic-shaped envelope; treat the whole body as the text.
    }

    // Build the compacted file: one summary exchange + kept exchanges.
    const summaryLine = JSON.stringify({
      request: { messages: [{ role: "user", content: summary }] },
      response: { content: [{ type: "text", text: "[compacted summary]" }] },
    });
    const newContent = [summaryLine, ...keepLines].join("\n") + "\n";

    // Atomic write: write to .tmp, then rename.
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, newContent, "utf8");
    await rename(tmpPath, filePath);

    // Reset the curator cursor so the next curator pass doesn't try to
    // process the compacted summary as new content nor miss lines after
    // the old cursor (which was tracking the pre-compaction line count).
    const newLineCount = 1 + keepLines.length; // summary + kept lines
    cursor[file] = newLineCount;

    compacted++;
    const newBytes = Buffer.byteLength(newContent, "utf8");
    const byteDelta = bytes - newBytes;
    const detail =
      byteDelta >= 1024 * 1024
        ? `${(byteDelta / (1024 * 1024)).toFixed(1)} MB`
        : byteDelta >= 1024
          ? `${(byteDelta / 1024).toFixed(1)} KB`
          : `${byteDelta} B`;
    console.log(`[compact] ${file}: compacted ${compactCount} exchange(s) (${bytes}B -> ${newBytes}B, threshold=${compactThreshold}B)`);
    deps.runtime.activityLog.record({
      requestId: `compact-${Date.now().toString(36)}-${file.replace(".jsonl", "")}`,
      timestamp: Date.now(),
      outcome: "compact",
      provider: pick.providerKey,
      model: pick.model,
      fallbackSet: agent.fallbackSet ?? undefined,
      errorMessage: `compacted ${compactCount} exchange(s) (${bytes}B → ${newBytes}B, saved ${detail})`,
    });
  }

  await saveCursor(cursor);
  return compacted;
}

/** Takes a deps thunk rather than a fixed object so a live config reload
 * (e.g. from the admin UI) is picked up on the next tick instead of
 * requiring a restart. The thunk may resolve to `embedding: null` when
 * no embeddings global agent has been configured -- the curator still
 * runs (so its presence is obvious in logs) but skips fact storage
 * rather than crashing. Runs compact pass first (to keep session files
 * under the size threshold) then the curator pass (to extract facts from
 * any new exchanges). Both errors are caught independently so a failure
 * in one does not strand the other. */
export function startCurator(getDeps: () => CuratorDeps, intervalMs: number): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await runCompactPass(getDeps());
    } catch (err) {
      console.error("compact pass failed:", err);
    }
    try {
      await runCuratorPass(getDeps());
    } catch (err) {
      console.error("curator pass failed:", err);
    }
  }, intervalMs);
}
