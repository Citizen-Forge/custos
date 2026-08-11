import { JsonCollection, newId, pmPath } from "./store.js";

/**
 * The project's shared knowledge — what every agent needs to know and no
 * single agent owns.
 *
 * Without this, facts discovered by one role die with its run: DevOps
 * creates a repository and the engineers never learn its URL; QA works out
 * that the test suite needs `pnpm test:ci` and the next engineer rediscovers
 * it the hard way. Passing those between agents through prompts would mean
 * every role knowing which other roles exist. A shared store means each one
 * only has to know the project.
 *
 * It is deliberately small and flat. This is a team's shared context, not a
 * database — if something belongs to one ticket it goes on the ticket.
 */

export type FactCategory = "repo" | "environment" | "convention" | "docs" | "decision" | "contact";

export const FACT_CATEGORIES: FactCategory[] = ["repo", "environment", "convention", "docs", "decision", "contact"];

export interface ProjectFact {
  id: string;
  projectId: string;
  /** Short stable identifier, e.g. "repo.url", "test.command". Unique per
   * project -- writing the same key again updates it rather than adding a
   * second, contradictory copy. */
  key: string;
  value: string;
  category: FactCategory;
  /** Agent id, or "human". Shown to agents so they can weigh a fact written
   * by the role that owns it against one inferred by somebody passing. */
  writtenBy: string;
  writtenByLabel: string;
  createdAt: number;
  updatedAt: number;
}

const facts = new JsonCollection<ProjectFact>(pmPath("project-facts.json"));

export async function listFacts(projectId: string): Promise<ProjectFact[]> {
  const rows = await facts.find((row) => row.projectId === projectId);
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

export async function getFact(projectId: string, key: string): Promise<ProjectFact | null> {
  const rows = await facts.find((row) => row.projectId === projectId && row.key === key);
  return rows[0] ?? null;
}

export interface WriteFactInput {
  projectId: string;
  key: string;
  value: string;
  category?: FactCategory;
  writtenBy?: string;
  writtenByLabel?: string;
}

/** Upsert by (projectId, key). Agents write the same key repeatedly as they
 * learn more; the newest value wins and the authorship updates with it. */
export async function writeFact(input: WriteFactInput): Promise<ProjectFact> {
  const key = input.key.trim();
  const existing = await getFact(input.projectId, key);
  const now = Date.now();

  if (existing) {
    const updated = await facts.update(existing.id, (fact) => {
      fact.value = input.value;
      if (input.category) fact.category = input.category;
      fact.writtenBy = input.writtenBy ?? "human";
      fact.writtenByLabel = input.writtenByLabel ?? "You";
      fact.updatedAt = now;
    });
    return updated ?? existing;
  }

  return facts.insert({
    id: newId(),
    projectId: input.projectId,
    key,
    value: input.value,
    category: input.category ?? "decision",
    writtenBy: input.writtenBy ?? "human",
    writtenByLabel: input.writtenByLabel ?? "You",
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteFact(id: string): Promise<boolean> {
  return facts.remove(id);
}

export async function deleteProjectFacts(projectId: string): Promise<number> {
  return facts.removeWhere((row) => row.projectId === projectId);
}

/** Hard cap on how many facts `renderFacts` embeds into an agent prompt.
 *  `writeFact` upserts by key exactly as designed, but that only helps
 *  when a model reuses a stable key -- in practice models keep inventing
 *  a new near-duplicate key per observation instead ("decision.capacity-
 *  2026-07-25", then "-25b", "-25c", "-25d"...), so the store still grows
 *  unbounded even though the upsert path itself works. Observed live: 114
 *  facts on one project (many day-stamped duplicates, several rows
 *  disputing the same fact with each other, a couple of outright
 *  hallucinated entries unrelated to the project), rendering to ~40KB
 *  that buried the actual task in every prompt on the project -- every
 *  role gets this header, not just the ones that showed it in this
 *  session's investigation. Same fix shape as MAX_RENDERED_COMMENTS/
 *  HISTORY in context.ts: cap what's shown to the most recently updated
 *  entries rather than trying to enforce write-time discipline the
 *  prompt already asks for and doesn't reliably get. */
const MAX_RENDERED_FACTS = 40;

/** Renders the store for an agent prompt. Grouped by category so a long
 * list stays scannable, and attributed so an agent can tell a decision the
 * human made from one another agent inferred. */
export function renderFacts(rows: ProjectFact[]): string {
  if (!rows.length) {
    return "## What the team knows\n\n_Nothing recorded yet. If you learn something the next agent on this project will need — where the repository is, how to run the tests, a convention you had to work out — record it._";
  }
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const shown = sorted.slice(0, MAX_RENDERED_FACTS);
  const omitted = sorted.length - shown.length;

  const byCategory = new Map<string, ProjectFact[]>();
  for (const fact of shown) {
    const list = byCategory.get(fact.category) ?? [];
    list.push(fact);
    byCategory.set(fact.category, list);
  }
  const lines = [
    "## What the team knows",
    "",
    "Shared across every agent on this project. Treat it as true unless you find otherwise — and if you do find otherwise, correct it.",
  ];
  if (omitted > 0) {
    lines.push(
      "",
      `Showing the ${shown.length} most recently updated of ${sorted.length} facts (${omitted} older ones omitted). If you're about to write a fact that's really the same thing as one already here under a different key, update THAT key instead of adding a new one — that's what's filling this list up.`,
    );
  }
  for (const [category, list] of byCategory) {
    lines.push("", `**${category}**`);
    for (const fact of list) lines.push(`- \`${fact.key}\`: ${fact.value}  _(${fact.writtenByLabel})_`);
  }
  return lines.join("\n");
}

/** The contract fragment every role gets, so any agent can contribute. */
export const FACTS_CONTRACT_FIELD = `"facts": [{ "key": "short.stable.key", "value": "what is true", "category": "repo" | "environment" | "convention" | "docs" | "decision" | "contact" }]`;
