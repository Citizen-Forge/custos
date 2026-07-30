// renderWorkItem contracts.
//
// Regression coverage for the E2BIG spawn bug: a ticket that accumulates
// many comments (each failed automated attempt logs one via
// board.addComment) used to have every single comment re-embedded into
// the agent prompt on every future render, with no cap. Once the combined
// argv+environ for the spawned `claude -p` subprocess crossed the OS's
// ARG_MAX, every attempt failed at spawn time before it could even reach
// a provider -- which itself got logged as another comment, guaranteeing
// the ticket could never recover. These tests pin the cap that prevents
// that death spiral.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderWorkItem } from "./context.js";
import type { WorkItem, Comment, HistoryEntry } from "./types.js";

function makeComment(i: number): Comment {
  return { id: `c${i}`, author: "agent", authorLabel: "QA", body: `comment ${i}`, createdAt: i };
}

function makeHistory(i: number): HistoryEntry {
  return { at: i, actor: "agent", from: "qa", to: "in_progress", note: `attempt ${i}` };
}

const BASE_ITEM: WorkItem = {
  id: "wi1",
  projectId: "p1",
  type: "story",
  status: "qa",
  parentId: null,
  title: "Test ticket",
  description: "A ticket",
  acceptanceCriteria: [],
  priority: 0,
  complexity: null,
  assigneeAgentId: null,
  subtasks: [],
  comments: [],
  labels: [],
  prUrl: null,
  prComments: [],
  branch: null,
  worktreePath: null,
  attempts: 0,
  nextAttemptAt: null,
  qaRounds: 0,
  sourceIdeaId: null,
  createdAt: 0,
  updatedAt: 0,
  history: [],
};

describe("renderWorkItem: comment/history caps", () => {
  it("renders all comments with no omission note when under the cap", () => {
    const item = { ...BASE_ITEM, comments: Array.from({ length: 5 }, (_, i) => makeComment(i)) };
    const out = renderWorkItem(item, { includeComments: true });
    assert.match(out, /\*\*Comments\*\*\n/, "no omission note when under the cap");
    assert.match(out, /comment 0/);
    assert.match(out, /comment 4/);
  });

  it("caps comments to the most recent 30 and notes how many were omitted", () => {
    const item = { ...BASE_ITEM, comments: Array.from({ length: 4447 }, (_, i) => makeComment(i)) };
    const out = renderWorkItem(item, { includeComments: true });
    assert.match(out, /showing the most recent 30 of 4447 — 4417 earlier omitted/);
    // Oldest comments dropped, most recent kept.
    assert.ok(!out.includes("comment 0\n") && !out.includes("- **QA**: comment 0"), "oldest comment omitted");
    assert.match(out, /comment 4446/, "most recent comment kept");
    // Exactly 30 comment lines rendered.
    const commentLines = out.split("\n").filter((l) => l.startsWith("- **QA**:"));
    assert.equal(commentLines.length, 30);
  });

  it("caps history to the most recent 20 and notes how many were omitted", () => {
    const item = { ...BASE_ITEM, history: Array.from({ length: 50 }, (_, i) => makeHistory(i)) };
    const out = renderWorkItem(item, { includeHistory: true });
    assert.match(out, /showing the most recent 20 of 50 — 30 earlier omitted/);
    assert.match(out, /attempt 49\)/, "most recent history entry kept");
    assert.ok(!out.includes("attempt 0)"), "oldest history entry omitted");
  });

  it("omits the Comments/History sections entirely when the arrays are empty", () => {
    const out = renderWorkItem(BASE_ITEM, { includeComments: true, includeHistory: true });
    assert.ok(!out.includes("**Comments**"));
    assert.ok(!out.includes("**History**"));
  });
});
