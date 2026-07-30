import { readFileSync } from "fs";
import { runCompactPass } from "/app/dist/memory/curator.js";

const config = JSON.parse(readFileSync("/app/data/config.json", "utf8"));
const runtime = { config };

// Read session file and simulate estimation
const lines = readFileSync("/app/data/sessions/2026-07-25.jsonl", "utf8").split("\n").filter(Boolean);
console.log("Session: 2026-07-25.jsonl, " + lines.length + " lines");

// Accumulate messages the same way the fix does
function extractContentText(content) {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

const accumulated = [];
for (const line of lines) {
  const parsed = JSON.parse(line);
  const msg = parsed.request?.messages?.at?.(-1);
  if (msg) {
    const text = extractContentText(msg.content);
    if (text) {
      accumulated.push({ role: msg.role || "user", content: text });
    }
  }
}
console.log("Accumulated messages:", accumulated.length);
const bytes = Buffer.byteLength(JSON.stringify({ messages: accumulated }), "utf8");
console.log("Estimated dispatch size:", (bytes / 1024 / 1024).toFixed(2), "MB");
const threshold = 33554432 * 0.6;
console.log("Compact threshold (60%):", (threshold / 1024 / 1024).toFixed(2), "MB");
console.log("Exceeds threshold?", bytes > threshold);

// Run the actual compact pass
const result = await runCompactPass({ runtime, store: null, embedding: null });
console.log("\nrunCompactPass returned:", result);

// Check cursor after
const cursor = JSON.parse(readFileSync("/app/data/curator-cursor.json", "utf8"));
console.log("2026-07-25 cursor:", cursor["2026-07-25.jsonl"]);
