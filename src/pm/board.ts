import { JsonCollection, newId, pmPath } from "./store.js";
import type { BoardStatus, Comment, Complexity, Subtask, WorkItem, WorkItemType } from "./types.js";

const items = new JsonCollection<WorkItem>(pmPath("work-items.json"));

/**
 * Which columns each role is allowed to move a ticket into. The board is
 * driven by autonomous agents, so the lifecycle is enforced here rather
 * than trusted to prompt-following -- a confused engineer agent claiming a
 * ticket is "complete" can't skip QA, it can only push to qa and let the
 * QA agent make that call. Humans are deliberately unrestricted: the whole
 * board is theirs to override.
 */
export const ROLE_TRANSITIONS: Record<string, BoardStatus[]> = {
  "product-owner": ["backlog", "ready"],
  "engineering-manager": ["ready", "in_progress"],
  engineer: ["qa", "in_progress"],
  qa: ["complete", "in_progress"],
  devops: ["complete"],
  human: ["backlog", "ready", "in_progress", "qa", "complete"],
};

export function canTransition(actorRole: string, to: BoardStatus): boolean {
  return (ROLE_TRANSITIONS[actorRole] ?? []).includes(to);
}

export interface CreateWorkItemInput {
  projectId: string;
  type: WorkItemType;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  parentId?: string | null;
  status?: BoardStatus;
  priority?: number;
  complexity?: Complexity | null;
  labels?: string[];
  sourceIdeaId?: string | null;
  actor?: string;
}

export async function listWorkItems(projectId?: string): Promise<WorkItem[]> {
  const rows = projectId ? await items.find((row) => row.projectId === projectId) : await items.list();
  return rows.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  return items.get(id);
}

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  const now = Date.now();
  const status = input.status ?? "backlog";
  const item: WorkItem = {
    id: newId(),
    projectId: input.projectId,
    type: input.type,
    status,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    priority: input.priority ?? now / 1000,
    complexity: input.complexity ?? null,
    assigneeAgentId: null,
    subtasks: [],
    comments: [],
    labels: input.labels ?? [],
    prUrl: null,
    branch: null,
    qaRounds: 0,
    sourceIdeaId: input.sourceIdeaId ?? null,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, actor: input.actor ?? "human", from: null, to: status, note: "created" }],
  };
  return items.insert(item);
}

/** Field edits that don't touch status -- status always goes through
 * transitionWorkItem so the history stays a complete record of the
 * lifecycle rather than a partial one. */
export type WorkItemPatch = Partial<
  Pick<
    WorkItem,
    "title" | "description" | "acceptanceCriteria" | "priority" | "complexity" | "labels" | "parentId" | "prUrl" | "branch" | "assigneeAgentId" | "subtasks"
  >
>;

export async function updateWorkItem(id: string, patch: WorkItemPatch): Promise<WorkItem | null> {
  return items.update(id, (item) => {
    Object.assign(item, patch);
    item.updatedAt = Date.now();
  });
}

export async function transitionWorkItem(id: string, to: BoardStatus, actor: string, note?: string): Promise<WorkItem | null> {
  return items.update(id, (item) => {
    if (item.status === to) return;
    // Every bounce out of QA is a quality signal the EM reads back when it
    // tunes the agent that produced the work, so count it at the moment it
    // happens rather than trying to infer it from history later.
    if (item.status === "qa" && to === "in_progress") item.qaRounds += 1;
    item.history.push({ at: Date.now(), actor, from: item.status, to, note });
    item.status = to;
    item.updatedAt = Date.now();
  });
}

export async function addComment(id: string, author: string, authorLabel: string, body: string): Promise<Comment | null> {
  let comment: Comment | null = null;
  await items.update(id, (item) => {
    comment = { id: newId(), author, authorLabel, body, createdAt: Date.now() };
    item.comments.push(comment);
    item.updatedAt = Date.now();
  });
  return comment;
}

export async function setSubtasks(id: string, titles: string[]): Promise<WorkItem | null> {
  return items.update(id, (item) => {
    // Preserve done-ness for subtasks whose title is unchanged, so an agent
    // re-reporting its plan mid-ticket doesn't silently un-tick finished work.
    const doneTitles = new Set(item.subtasks.filter((s) => s.done).map((s) => s.title));
    item.subtasks = titles.map<Subtask>((title) => ({ id: newId(), title, done: doneTitles.has(title) }));
    item.updatedAt = Date.now();
  });
}

export async function setSubtaskDone(id: string, subtaskId: string, done: boolean): Promise<WorkItem | null> {
  return items.update(id, (item) => {
    const subtask = item.subtasks.find((s) => s.id === subtaskId);
    if (subtask) subtask.done = done;
    item.updatedAt = Date.now();
  });
}

export async function deleteWorkItem(id: string): Promise<boolean> {
  // Deleting an epic orphans its stories rather than deleting them -- the
  // work described by a story is real even when the epic framing it turned
  // out to be wrong, so they fall back to the board as parentless.
  const children = await items.find((row) => row.parentId === id);
  for (const child of children) {
    await items.update(child.id, (item) => {
      item.parentId = null;
      item.updatedAt = Date.now();
    });
  }
  return items.remove(id);
}

export async function deleteProjectWorkItems(projectId: string): Promise<number> {
  return items.removeWhere((row) => row.projectId === projectId);
}

export interface EpicWithChildren {
  epic: WorkItem;
  children: WorkItem[];
  /** Fraction of children in "complete", 0 when there are none yet. */
  progress: number;
}

/** The roadmap view: epics with their stories/bugs nested underneath. */
export async function listEpics(projectId: string): Promise<EpicWithChildren[]> {
  const all = await listWorkItems(projectId);
  const epics = all.filter((item) => item.type === "epic");
  return epics.map((epic) => {
    const children = all.filter((item) => item.parentId === epic.id);
    const done = children.filter((child) => child.status === "complete").length;
    return { epic, children, progress: children.length ? done / children.length : 0 };
  });
}

/** Tickets (stories and bugs) for the kanban board, grouped by column. */
export async function listBoard(projectId: string): Promise<Record<BoardStatus, WorkItem[]>> {
  const all = await listWorkItems(projectId);
  const board = { backlog: [], ready: [], in_progress: [], qa: [], complete: [] } as Record<BoardStatus, WorkItem[]>;
  for (const item of all) {
    if (item.type === "epic") continue;
    board[item.status].push(item);
  }
  return board;
}

/** First item matching a status, in priority order -- how the orchestrator
 * pulls the next piece of work for a role without scanning the whole board. */
export async function nextInStatus(projectId: string, status: BoardStatus, type?: WorkItemType): Promise<WorkItem | null> {
  const all = await listWorkItems(projectId);
  return all.find((item) => item.status === status && (!type || item.type === type)) ?? null;
}
