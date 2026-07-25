import { JsonCollection, newId, pmPath } from "./store.js";
import type { Idea } from "./types.js";

const ideas = new JsonCollection<Idea>(pmPath("ideas.json"));

export async function listIdeas(projectId?: string): Promise<Idea[]> {
  const rows = projectId ? await ideas.find((row) => row.projectId === projectId) : await ideas.list();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getIdea(id: string): Promise<Idea | null> {
  return ideas.get(id);
}

export async function createIdea(projectId: string, title: string, brief: string, sourceChatId: string | null): Promise<Idea> {
  const now = Date.now();
  return ideas.insert({
    id: newId(),
    projectId,
    title,
    brief,
    sourceChatId,
    status: "inbox",
    epicIds: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Claims an inbox idea for planning. Returns null if someone else already
 * claimed it -- the orchestrator can tick concurrently with a human
 * clicking "plan now", and only one product-owner run should start. */
export async function claimIdeaForPlanning(id: string): Promise<Idea | null> {
  const claimed = await ideas.update(id, (idea) => {
    if (idea.status !== "inbox") return;
    idea.status = "planning";
    idea.error = null;
    idea.updatedAt = Date.now();
  });
  return claimed?.status === "planning" ? claimed : null;
}

export async function markIdeaPlanned(id: string, epicIds: string[]): Promise<Idea | null> {
  return ideas.update(id, (idea) => {
    idea.status = "planned";
    idea.epicIds = epicIds;
    idea.error = null;
    idea.updatedAt = Date.now();
  });
}

/** Returns a failed planning run to the inbox so it can be retried, keeping
 * the error visible on the card rather than stranding it in "planning". */
export async function markIdeaFailed(id: string, error: string): Promise<Idea | null> {
  return ideas.update(id, (idea) => {
    idea.status = "inbox";
    idea.error = error;
    idea.updatedAt = Date.now();
  });
}

export async function setIdeaStatus(id: string, status: Idea["status"]): Promise<Idea | null> {
  return ideas.update(id, (idea) => {
    idea.status = status;
    idea.updatedAt = Date.now();
  });
}

export async function deleteIdea(id: string): Promise<boolean> {
  return ideas.remove(id);
}

export async function deleteProjectIdeas(projectId: string): Promise<number> {
  return ideas.removeWhere((row) => row.projectId === projectId);
}
