// Pins the near-duplicate-fact detection added after a live incident: the
// curator's extraction model has no visibility into what's already stored,
// so it re-"discovers" the same durable-looking facts (a repo URL, an
// architecture rule) every time they appear in a fresh batch of exchanges.
// One project's memory store accumulated 1,100+ near-duplicate restatements
// this way, which then got dumped into every UserPromptSubmit hook's
// injected context. Calibrated against real data from that store: cosine
// similarity on this embedding model didn't reliably separate true
// duplicates from unrelated facts (a confirmed duplicate pair scored 0.93,
// an unrelated fact scored 0.91), so these tests exercise the word-overlap
// check that replaced a bare similarity threshold.
import test from "node:test";
import assert from "node:assert/strict";
import { isNearDuplicateFact } from "./search.js";
import type { MemoryStore } from "./store.js";

function fakeStore(candidates: { text: string; topic: string }[]): MemoryStore {
  return {
    search: async () => candidates.map((c) => ({ ...c, sourceSessionId: "s", createdAt: "2026-01-01", score: 0.9 })),
  } as unknown as MemoryStore;
}

test("flags a near-verbatim restatement as a duplicate", async () => {
  const store = fakeStore([
    { text: "Repository: https://github.com/Tall-Paul/lightspeed, default branch: main, no deploy target configured.", topic: "repo" },
  ]);
  const isDup = await isNearDuplicateFact(store, [0, 0], "Repository: https://github.com/Tall-Paul/lightspeed, default branch main, no deploy target configured");
  assert.equal(isDup, true);
});

test("does not flag a genuinely different fact sharing only a few words", async () => {
  const store = fakeStore([
    { text: "Repository: https://github.com/Tall-Paul/lightspeed, default branch: main.", topic: "repo" },
  ]);
  const isDup = await isNearDuplicateFact(store, [0, 0], "The user prefers dark mode in the admin UI and wants terse commit messages.");
  assert.equal(isDup, false);
});

test("returns false when the store has no candidates", async () => {
  const store = fakeStore([]);
  const isDup = await isNearDuplicateFact(store, [0, 0], "Anything at all.");
  assert.equal(isDup, false);
});

test("checks every candidate, not just the first", async () => {
  const store = fakeStore([
    { text: "Completely unrelated fact about the AI belief-state epic.", topic: "decision" },
    { text: "Repository: https://github.com/Tall-Paul/lightspeed, default branch main. Architecture enforced by test/architecture.test.ts.", topic: "repo" },
  ]);
  const isDup = await isNearDuplicateFact(store, [0, 0], "Repository: https://github.com/Tall-Paul/lightspeed, default branch: main. Architecture is enforced by test/architecture.test.ts.");
  assert.equal(isDup, true);
});
