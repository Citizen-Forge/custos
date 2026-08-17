// Pins the protected-message contract in truncateOldestMessages: the most
// recent role:"user" message is the live instruction for this turn (on an
// agent's first turn, the entire task -- e.g. Custos's rendered work-item
// prompt) and must never be a removal candidate. Confirmed live via a
// captured request/response replay: a project whose system prompt + tool
// schemas + hook-injected memory context already sat near the byte cap
// caused the pre-fix age-based loop to delete exactly that message on
// turn one, leaving the model with generic project context but no idea
// what ticket it was working -- it then explored the codebase aimlessly
// for dozens of retries. See truncate.ts's doc comment for the full story.
import test from "node:test";
import assert from "node:assert/strict";
import { truncateOldestMessages } from "./truncate.js";
import type { OpenAIMessage, OpenAIRequest } from "../types.js";

function msg(role: OpenAIMessage["role"], content: string): OpenAIMessage {
  return { role, content };
}

function req(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "test", messages, max_tokens: 1000, stream: false };
}

test("never removes the most recent user message even when it alone forces the request over the cap", () => {
  // Mirrors a real agent's first turn: system prompt, the live task (the
  // work-item render), then a system-reminder Claude Code appends after
  // the user turn (hook-injected memory context). Total exceeds a small
  // cap, so *something* has to go -- it must not be the task.
  const request = req([
    msg("system", "x".repeat(2000)),
    msg("user", "YOUR TICKET: implement the thing. Acceptance criteria: A, B, C."),
    msg("system", "y".repeat(2000)),
  ]);
  const before = Buffer.byteLength(JSON.stringify(request), "utf8");
  const result = truncateOldestMessages(request, before, 2500);
  assert.ok(result, "expected a truncation result, not undefined");
  const roles = result!.request.messages.map((m) => m.role);
  const userMsg = result!.request.messages.find((m) => m.role === "user");
  assert.ok(userMsg, "the user message must survive removal");
  assert.equal(userMsg!.content, "YOUR TICKET: implement the thing. Acceptance criteria: A, B, C.");
  assert.ok(roles.includes("system"), "system prompt at index 0 must survive");
});

test("drains old tool/assistant turns before ever touching the protected user message", () => {
  const messages: OpenAIMessage[] = [msg("system", "sys")];
  messages.push(msg("user", "LIVE TASK: do the real work"));
  // A long tail of old tool-call round-trips, each individually small but
  // collectively pushing the request over the cap.
  for (let i = 0; i < 20; i++) {
    messages.push(msg("assistant", `old-assistant-turn-${i}-`.repeat(20)));
    messages.push(msg("tool", `old-tool-result-${i}-`.repeat(20)));
  }
  const request = req(messages);
  const before = Buffer.byteLength(JSON.stringify(request), "utf8");
  const result = truncateOldestMessages(request, before, Math.floor(before * 0.2));
  assert.ok(result);
  const userMsg = result!.request.messages.find((m) => m.role === "user" && m.content === "LIVE TASK: do the real work");
  assert.ok(userMsg, "the live task must still be present after draining old turns");
});

test("falls back to content-truncation of the protected message only as a last resort", () => {
  // No old turns to drop -- system + the live task is ALL there is, and
  // even that doesn't fit. The user message must survive (truncated in
  // content, not removed) rather than disappearing.
  const request = req([
    msg("system", "s".repeat(500)),
    msg("user", "TASK: ".repeat(2000)),
  ]);
  const before = Buffer.byteLength(JSON.stringify(request), "utf8");
  // req.messages.length is 2, below the < 3 early-return threshold, so
  // this exercises fitRequestToSize's caller contract rather than this
  // function directly -- truncateOldestMessages itself declines (returns
  // undefined) below 3 messages, which is the correct "nothing to drop"
  // signal for a genuinely single-turn request.
  const result = truncateOldestMessages(request, before, 100);
  assert.equal(result, undefined);
});

test("removes an assistant tool_calls message and its tool-response together, never splitting the pair", () => {
  // Confirmed live 2026-08-17: a self-hosted upstream's chat-template
  // rendering rejects a request outright ("Message has tool role, but
  // there was no tool call") when an assistant tool_calls message and
  // its tool-role response get split by removal -- one survives, the
  // other doesn't. The pre-fix age-based loop removed by raw index with
  // no notion of this pairing.
  const messages: OpenAIMessage[] = [msg("system", "sys")];
  messages.push(msg("user", "LIVE TASK: do the real work"));
  for (let i = 0; i < 20; i++) {
    const callId = `call-${i}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: callId, type: "function", function: { name: "read_file", arguments: `{"path":"file-${i}.ts"}` } }],
    });
    messages.push({ role: "tool", content: `result-${i}-`.repeat(50), tool_call_id: callId });
  }
  const request = req(messages);
  const before = Buffer.byteLength(JSON.stringify(request), "utf8");
  const result = truncateOldestMessages(request, before, Math.floor(before * 0.2));
  assert.ok(result);

  const survivingCalls = new Set(result!.request.messages.flatMap((m) => m.tool_calls?.map((tc) => tc.id) ?? []));
  const answeredCalls = new Set(
    result!.request.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  for (const m of result!.request.messages) {
    if (m.role === "tool") {
      assert.ok(m.tool_call_id && survivingCalls.has(m.tool_call_id), `orphaned tool message answering missing call ${m.tool_call_id}`);
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        assert.ok(answeredCalls.has(tc.id), `assistant tool_calls id=${tc.id} has no surviving tool response`);
      }
    }
  }
});

test("still drops old turns normally when there is no user-role message at all", () => {
  // Defensive: a conversation with no user role (shouldn't happen in
  // practice, but the function must not throw) still truncates old
  // messages by age as before.
  const messages: OpenAIMessage[] = [msg("system", "sys")];
  for (let i = 0; i < 10; i++) {
    messages.push(msg("assistant", `turn-${i}-`.repeat(50)));
  }
  const request = req(messages);
  const before = Buffer.byteLength(JSON.stringify(request), "utf8");
  const result = truncateOldestMessages(request, before, Math.floor(before * 0.3));
  assert.ok(result);
  assert.ok(result!.request.messages.length < messages.length);
});
