#!/usr/bin/env node
// Manual compaction estimation test.  Same logic as curator.ts runCompactPass
// but without the LLM call — purely for verifying the byte estimation.

const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
const { readdir, readFile } = await import("node:fs/promises");
const { join } = await import("node:path");

function extractContentText(content) {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "tool_result" && typeof block.content === "string") texts.push(block.content);
        else if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner && typeof inner === "object" && inner.type === "text" && typeof inner.text === "string") texts.push(inner.text);
          }
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

// Find maxRequestBytes
let maxRequestBytes = 32 * 1024 * 1024; // default
const fs = await import("node:fs");
try {
  const configStr = fs.readFileSync("/app/dist/config.js", "utf8");
  // Parse the default export or gateway config
  const config = await import("/app/dist/config.js");
  const loaded = await config.loadConfig();
  for (const def of Object.values(loaded.providers ?? {})) {
    if (def.maxRequestBytes !== undefined && def.maxRequestBytes < maxRequestBytes) {
      maxRequestBytes = def.maxRequestBytes;
    }
  }
} catch {}
const compactThreshold = maxRequestBytes * 0.6;
console.log(`[compact] maxRequestBytes=${maxRequestBytes} (${(maxRequestBytes/1024/1024).toFixed(0)} MB), threshold=${(compactThreshold/1024/1024).toFixed(1)} MB`);

const files = (await readdir(SESSIONS_DIR)).filter(f => f.endsWith(".jsonl")).sort();

for (const file of files) {
  const filePath = join(SESSIONS_DIR, file);
  let content;
  try { content = await readFile(filePath, "utf8"); }
  catch { continue; }
  const lines = content.split("\n").filter(Boolean);
  if (lines.length < 4) continue;

  let estimateBytes = 0;
  let messageCount = 0;
  let hasTrailingAssistant = false;
  let staticToolsBytes = 0;
  let staticSystemBytes = 0;

  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { continue; }

    // Track static overhead from last parsed line
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
          estimateBytes += 30 + Buffer.byteLength(text, "utf8");
          messageCount++;
        } else if (msg.role === "user") {
          estimateBytes += 28 + Buffer.byteLength(text, "utf8");
          messageCount++;
          hasTrailingAssistant = false;
        }
      }
    }
    const assistantBlock = parsed.response?.content?.find(b => b.type === "text");
    if (assistantBlock?.text) {
      estimateBytes += 34 + Buffer.byteLength(assistantBlock.text, "utf8");
      messageCount++;
      hasTrailingAssistant = true;
    }
  }

  // Subtract trailing assistant
  if (hasTrailingAssistant) {
    const lastLine = lines[lines.length - 1];
    try {
      const lastParsed = JSON.parse(lastLine);
      const lastBlock = lastParsed.response?.content?.find(b => b.type === "text");
      if (lastBlock?.text) {
        estimateBytes -= 34 + Buffer.byteLength(lastBlock.text, "utf8");
        messageCount--;
      }
    } catch {}
  }

  let bytes = estimateBytes + 15 + (messageCount > 0 ? messageCount - 1 : 0);
  bytes += staticToolsBytes;
  bytes += staticSystemBytes;

  const pct = ((bytes / compactThreshold) * 100).toFixed(1);
  const status = bytes > compactThreshold ? "⚠ OVER ⚠" :
                 bytes > compactThreshold * 0.5 ? "> 50%" :
                 "OK";
  const sizeMB = (Buffer.byteLength(content, "utf8") / 1024 / 1024).toFixed(1);
  const estMB = (bytes / 1024 / 1024).toFixed(2);
  const details = staticToolsBytes > 0 ? ` (msgs=${(estimateBytes/1024).toFixed(0)} KB + tools=${(staticToolsBytes/1024).toFixed(0)} KB + sys=${(staticSystemBytes/1024).toFixed(0)} KB)` : "";

  console.log(`${file}: ${sizeMB} MB on disk, ${lines.length} lines → ~${estMB} MB estimated (${pct}% of threshold) [${status}]${details}`);
}

console.log(`\nEstimation ${files.length > 0 ? `complete (${files.length} files)` : "no files"}.`);
