#!/usr/bin/env node
const SESSIONS_DIR = process.env.GATEWAY_SESSIONS_DIR ?? "data/sessions";
const { readdir, readFile } = await import("node:fs/promises");
const { join } = await import("node:path");

const files = (await readdir(SESSIONS_DIR)).filter(f => f.endsWith(".jsonl")).sort();

for (const file of files) {
  if (!file.includes("2026-07-25") && !file.includes("2026-07-26")) continue;
  
  const filePath = join(SESSIONS_DIR, file);
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  
  // Last line
  const parsed = JSON.parse(lines[lines.length - 1]);
  
  // Top-level keys
  const topKeys = Object.keys(parsed);
  const keySizes = {};
  for (const key of topKeys) {
    keySizes[key] = Buffer.byteLength(JSON.stringify(parsed[key]), "utf8");
  }
  
  // Request keys
  const reqKeys = parsed.request ? Object.keys(parsed.request) : [];
  if (parsed.request) {
    for (const key of reqKeys) {
      keySizes[`request.${key}`] = Buffer.byteLength(JSON.stringify(parsed.request[key]), "utf8");
    }
  }
  
  // Response keys
  const respKeys = parsed.response ? Object.keys(parsed.response) : [];
  if (parsed.response) {
    for (const key of respKeys) {
      keySizes[`response.${key}`] = Buffer.byteLength(JSON.stringify(parsed.response[key]), "utf8");
    }
  }
  
  console.log(`\n=== ${file}: last line = ${(Buffer.byteLength(lines[lines.length-1], "utf8")/1024).toFixed(0)} KB ===`);
  const sorted = Object.entries(keySizes).sort((a, b) => b[1] - a[1]);
  for (const [key, bytes] of sorted) {
    console.log(`  ${key}: ${(bytes/1024).toFixed(0)} KB`);
  }
  
  // Also check request field names
  console.log(`  request keys: ${reqKeys.join(", ")}`);
  console.log(`  request.messages length: ${parsed.request?.messages?.length || 0}`);
  console.log(`  response keys: ${respKeys.join(", ")}`);
  
  // Check if tools exist and how many
  if (parsed.request?.tools) {
    console.log(`  request.tools: ${parsed.request.tools.length} tools`);
    for (const t of parsed.request.tools.slice(0, 3)) {
      console.log(`    tool: ${t.name || t.function?.name} - ${(JSON.stringify(t).length/1024).toFixed(0)} KB`);
    }
  }
  
  // Check system prompt
  if (parsed.request?.system) {
    const sysLen = Buffer.byteLength(JSON.stringify(parsed.request.system), "utf8");
    console.log(`  request.system: ${(sysLen/1024).toFixed(0)} KB`);
  }
  
  // Mid line comparison
  if (lines.length > 10) {
    const midIdx = Math.floor(lines.length / 2);
    const midLine = lines[midIdx];
    const midParsed = JSON.parse(midLine);
    const midKeys = Object.keys(midParsed);
    const midKeySizes = {};
    for (const key of midKeys) {
      midKeySizes[key] = Buffer.byteLength(JSON.stringify(midParsed[key]), "utf8");
    }
    if (midParsed.request) {
      for (const key of Object.keys(midParsed.request)) {
        midKeySizes[`request.${key}`] = Buffer.byteLength(JSON.stringify(midParsed.request[key]), "utf8");
      }
    }
    if (midParsed.response) {
      for (const key of Object.keys(midParsed.response)) {
        midKeySizes[`response.${key}`] = Buffer.byteLength(JSON.stringify(midParsed.response[key]), "utf8");
      }
    }
    console.log(`  [mid line ${midIdx}]: ${(midLine.length/1024).toFixed(0)} KB`);
    const midSorted = Object.entries(midKeySizes).sort((a, b) => b[1] - a[1]);
    for (const [key, bytes] of midSorted.slice(0, 5)) {
      console.log(`    ${key}: ${(bytes/1024).toFixed(0)} KB`);
    }
  }
}
