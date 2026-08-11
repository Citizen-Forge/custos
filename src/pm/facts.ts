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

/** "pending" facts were proposed by an agent (`proposeFact`, backing the
 *  `record_fact` tool and the contract-based `facts` field every non-tool-
 *  driven role can also fill in) and haven't been reviewed yet -- they don't
 *  render into any prompt. "approved" facts do. Rows written before this
 *  field existed have no `status` at all; they're treated as approved (see
 *  `isApproved`) rather than requiring a one-off migration. */
export type FactStatus = "pending" | "approved";

export interface ProjectFact {
  id: string;
  projectId: string;
  /** Short stable identifier, e.g. "repo.url", "test.command". Unique per
   * project *within a status* -- writing the same key again as the same
   * status updates it rather than adding a second, contradictory copy. A
   * pending proposal against an already-approved key doesn't touch the
   * approved row until a curator approves it. */
  key: string;
  value: string;
  category: FactCategory;
  /** Agent id, or "human". Shown to agents so they can weigh a fact written
   * by the role that owns it against one inferred by somebody passing. */
  writtenBy: string;
  writtenByLabel: string;
  createdAt: number;
  updatedAt: number;
  status?: FactStatus;
}

const facts = new JsonCollection<ProjectFact>(pmPath("project-facts.json"));

function isApproved(row: ProjectFact): boolean {
  return row.status !== "pending";
}

/** Everything, pending and approved -- what the admin UI's facts panel
 *  shows so a human can review either pile. */
export async function listFacts(projectId: string): Promise<ProjectFact[]> {
  const rows = await facts.find((row) => row.projectId === projectId);
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

/** What every role's prompt is built from -- see `renderFacts`. */
export async function listApprovedFacts(projectId: string): Promise<ProjectFact[]> {
  const rows = await facts.find((row) => row.projectId === projectId && isApproved(row));
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

/** The curator's review queue, oldest proposal first. */
export async function listPendingFacts(projectId: string): Promise<ProjectFact[]> {
  const rows = await facts.find((row) => row.projectId === projectId && row.status === "pending");
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

async function findFact(projectId: string, key: string, status: FactStatus): Promise<ProjectFact | null> {
  const rows = await facts.find((row) => row.projectId === projectId && row.key === key && (status === "approved" ? isApproved(row) : row.status === "pending"));
  return rows[0] ?? null;
}

export async function getFact(projectId: string, key: string): Promise<ProjectFact | null> {
  return findFact(projectId, key, "approved");
}

export interface WriteFactInput {
  projectId: string;
  key: string;
  value: string;
  category?: FactCategory;
  writtenBy?: string;
  writtenByLabel?: string;
}

/** Upsert by (projectId, key), immediately approved -- writes the shared
 * store directly without going through review. For human/UI edits and the
 * handful of system-generated single-key facts (e.g. the codebase survey's
 * `project.overview`) that are low-noise by construction. Agent-authored
 * facts that need review go through `proposeFact` instead. */
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
      fact.status = "approved";
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
    status: "approved",
  });
}

/** Upsert by (projectId, key) into the PENDING pile -- an agent proposing a
 * fact via `record_fact` or a role's contract-based `facts` field lands
 * here, not in what other agents' prompts see. Re-proposing the same key
 * before it's been reviewed updates that same pending row rather than
 * stacking up duplicates; it never touches an already-approved row under
 * the same key, so an unreviewed proposal can't silently blank out
 * something already vetted. */
export async function proposeFact(input: WriteFactInput): Promise<ProjectFact> {
  const key = input.key.trim();
  const existing = await findFact(input.projectId, key, "pending");
  const now = Date.now();

  if (existing) {
    const updated = await facts.update(existing.id, (fact) => {
      fact.value = input.value;
      if (input.category) fact.category = input.category;
      fact.writtenBy = input.writtenBy ?? "agent";
      fact.writtenByLabel = input.writtenByLabel ?? "Agent";
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
    writtenBy: input.writtenBy ?? "agent",
    writtenByLabel: input.writtenByLabel ?? "Agent",
    createdAt: now,
    updatedAt: now,
    status: "pending",
  });
}

/** Promotes a pending proposal into the approved store (upserting against
 * any existing approved row under the same key, exactly like a direct
 * `writeFact` would) and removes the pending row. Optional overrides let a
 * curator consolidate a proposal into a cleaner key/value than what the
 * proposing agent wrote, without a second round trip. Returns null if `id`
 * isn't a pending fact (already reviewed, or never existed). */
export async function approveFact(id: string, overrides?: { key?: string; value?: string; category?: FactCategory }): Promise<ProjectFact | null> {
  const rows = await facts.find((row) => row.id === id);
  const pending = rows[0];
  if (!pending || pending.status !== "pending") return null;
  const approved = await writeFact({
    projectId: pending.projectId,
    key: (overrides?.key ?? pending.key).trim(),
    value: overrides?.value ?? pending.value,
    category: overrides?.category ?? pending.category,
    writtenBy: pending.writtenBy,
    writtenByLabel: pending.writtenByLabel,
  });
  await facts.remove(pending.id);
  return approved;
}

/** Discards a pending proposal without touching any approved fact under
 * the same key. Returns false if `id` isn't a pending fact. */
export async function rejectFact(id: string): Promise<boolean> {
  const rows = await facts.find((row) => row.id === id);
  const pending = rows[0];
  if (!pending || pending.status !== "pending") return false;
  return facts.remove(id);
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

/** Renders the pending queue for the curator's prompt, with ids so its
 * approve_fact/reject_fact tool calls can reference a specific row. Not
 * capped like `renderFacts` -- pending facts are the thing being cleared
 * out, not a per-run context cost paid by every other role. */
export function renderPendingFacts(rows: ProjectFact[]): string {
  if (!rows.length) return "_Nothing pending._";
  return rows.map((fact) => `- \`${fact.id}\` [${fact.category}] \`${fact.key}\`: ${fact.value}  _(proposed by ${fact.writtenByLabel})_`).join("\n");
}
