// The compaction pass: rewrites session files whose estimated dispatch
// size exceeds a provider's request-size cap, replacing the oldest half of
// exchanges with a structured summary from the memoryCurator global agent.
import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalAgent } from "../../pm/global-agents.js";
import { primaryPick } from "../../pm/agents.js";
import { extractContentText } from "./text-extraction.js";
import { SESSIONS_DIR, loadCursor, saveCursor, truncate, type CuratorDeps } from "./shared.js";

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
