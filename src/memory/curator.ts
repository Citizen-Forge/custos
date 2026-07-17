import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRouter } from "../providers/router.js";
import type { EmbeddingConfig } from "./embeddings.js";
import { embed } from "./embeddings.js";
import { MemoryStore } from "./store.js";

const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
const CURSOR_PATH = process.env.GATEWAY_CURATOR_CURSOR_PATH ?? "data/curator-cursor.json";

const EXTRACTION_SYSTEM_PROMPT = `You curate long-term memory for a coding assistant from raw conversation exchanges. Extract only durable, semantically useful facts worth recalling in future unrelated sessions: user preferences, project decisions, recurring context, corrections the user gave. Ignore one-off task details, code diffs, and anything only useful within the current conversation.

Respond with ONLY a JSON array, each item: {"topic": "short label", "text": "the fact, self-contained and understandable out of context"}. Return [] if nothing durable is worth keeping.`;

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
  router: ProviderRouter;
  store: MemoryStore;
  embedding: EmbeddingConfig;
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

    const batchText = newLines
      .map((l) => {
        const { request, response } = JSON.parse(l);
        const userText = request.messages?.at(-1)?.content ?? "";
        const assistantText = response.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
        return `USER: ${typeof userText === "string" ? userText : JSON.stringify(userText)}\nASSISTANT: ${assistantText}`;
      })
      .join("\n---\n");

    const res = await deps.router.complete("memoryCurator", {
      model: "curator",
      system: EXTRACTION_SYSTEM_PROMPT,
      max_tokens: 1000,
      messages: [{ role: "user", content: batchText }],
    });
    const responseText = await new Response(res.body).text();

    let facts: { topic: string; text: string }[] = [];
    try {
      const json = JSON.parse(responseText);
      const contentText: string = json.content?.[0]?.text ?? responseText;
      const parsed = JSON.parse(contentText.trim());
      if (Array.isArray(parsed)) facts = parsed;
    } catch {
      facts = [];
    }

    for (const fact of facts) {
      const vector = await embed(deps.embedding, fact.text);
      await deps.store.upsert(
        { text: fact.text, topic: fact.topic, sourceSessionId: file, createdAt: new Date().toISOString() },
        vector,
      );
      factsStored++;
    }

    cursor[file] = lines.length;
  }

  await saveCursor(cursor);
  return factsStored;
}

/** Takes a deps thunk rather than a fixed object so a live config reload
 * (e.g. from the admin UI) is picked up on the next tick instead of
 * requiring a restart. */
export function startCurator(getDeps: () => CuratorDeps, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    runCuratorPass(getDeps()).catch((err) => console.error("curator pass failed:", err));
  }, intervalMs);
}
