// The curator pass: extracts durable facts from new session-file exchanges
// and stores them (with embeddings) in the memory store.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { embed } from "../embeddings.js";
import { getGlobalAgent } from "../../pm/global-agents.js";
import { primaryPick } from "../../pm/agents.js";
import { SESSIONS_DIR, chunk, extractJsonArray, loadCursor, saveCursor, truncate, type CuratorDeps } from "./shared.js";

const EXTRACTION_SYSTEM_PROMPT = `You curate long-term memory for a coding assistant from raw conversation exchanges. Extract only durable, semantically useful facts worth recalling in future unrelated sessions: user preferences, project decisions, recurring context, corrections the user gave. Ignore one-off task details, code diffs, and anything only useful within the current conversation.

Respond with ONLY a JSON array, each item: {"topic": "short label", "text": "the fact, self-contained and understandable out of context"}. Return [] if nothing durable is worth keeping.

Output rules, which matter more than being helpful:
- Your entire reply must be the JSON array and nothing else. No greeting, no explanation, no commentary on the conversation, no markdown fence.
- Do not reply to the conversation you are shown. You are not a participant in it — you are reading a transcript and cataloguing facts from it.
- If there is nothing worth keeping, the correct and complete reply is exactly: []`;

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
