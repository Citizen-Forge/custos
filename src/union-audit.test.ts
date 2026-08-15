import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

// Promote docs/union-audit.md into a CI gate. Every union member must have at
// least one literal occurrence across src/ and ui/src/ outside its declaring
// file, OR be listed in `schemaInert` for that union. Drift between the union
// literal and the runtime code shape surfaces as a test failure and forces
// either a schemaInert entry or a runtime fork. New union members added to the
// source after this test was written are caught here too -- the test parses
// the actual union declaration and rejects any mismatch with `members`. Update
// both this file and docs/union-audit.md in the same commit.
interface UnionCase {
  readonly union: string;
  readonly declared: string;
  readonly members: readonly string[];
  readonly schemaInert?: readonly string[];
}

const CASES: readonly UnionCase[] = [
  { union: "TaskKind", declared: "src/types.ts", members: ["general", "permissionClassifier", "memoryCurator"] },
  { union: "Priority", declared: "src/providers/types.ts", members: ["interactive", "background"] },
  { union: "AgentRole", declared: "src/pm/types.ts", members: ["steering", "product-owner", "engineering-manager", "engineer", "qa", "devops", "project-manager", "principal"] },
  { union: "ChatKind", declared: "src/remote/chats.ts", members: ["chat", "steering", "portfolio"] },
  { union: "createdBy", declared: "src/pm/types.ts", members: ["system", "engineering-manager", "human"] },
  { union: "WorkItemType", declared: "src/pm/types.ts", members: ["epic", "story", "bug"] },
  { union: "BOARD_STATUSES", declared: "src/pm/types.ts", members: ["backlog", "ready", "in_progress", "qa", "complete"] },
  { union: "Complexity", declared: "src/pm/types.ts", members: ["low", "medium", "high"] },
  { union: "DeployTarget", declared: "src/pm/types.ts", members: ["none", "docker-local", "aws"] },
  { union: "Billing", declared: "src/pm/model-registry.ts", members: ["subscription", "metered", "free"] },
];

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

function safeTsFiles(dir: string): string[] {
  try {
    return [...tsFiles(dir)];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const SRC = [...safeTsFiles("src"), ...safeTsFiles("ui/src")];
const norm = (p: string) => p.split(sep).join("/");

// Parse the source file and extract every string literal in the union's
// declaration, so the test fails if someone adds a member to the type without
// updating CASES (or vice versa). Handles three shapes:
//   - `type X = "a" | "b"`                 -- top-level type alias
//   - `const X = ["a", "b"] as const`      -- BOARD_STATUSES-style array literal
//   - `fieldName: "a" | "b"` inside an interface (createdBy on AgentDef)
function declaredMembersFor(declaredPath: string, unionName: string): string[] {
  const content = readFileSync(declaredPath, "utf8");
  const re = new RegExp(
    `(?:type\\s+${unionName}\\s*=|const\\s+${unionName}\\s*=|${unionName}\\s*:)\\s*(.+?);`,
    "s",
  );
  const match = content.match(re);
  if (!match) throw new Error(`Could not locate union "${unionName}" in ${declaredPath}`);
  return (match[1].match(/"[^"]*"/g) ?? []).map((lit) => lit.slice(1, -1));
}

function forksOutside(member: string, declaredPath: string): number {
  // Match the literal `"<member>"` surrounded by non-identifier chars so a
  // hypothetical `"low_cost"` does not match the needle for `"low"`, and a
  // hypothetical `"prefix-docker-local"` does not match `"docker-local"`.
  const re = new RegExp(`(?<![A-Za-z0-9_-])"${member}"(?![A-Za-z0-9_-])`, "g");
  let n = 0;
  for (const f of SRC) {
    if (norm(f) === norm(declaredPath)) continue;
    if ((readFileSync(f, "utf8").match(re) ?? []).length > 0) n += 1;
  }
  return n;
}

for (const c of CASES) {
  test(`${c.union}: declared members match CASES, every member has a runtime fork or schema-inert`, () => {
    const declared = new Set(declaredMembersFor(c.declared, c.union));
    const audited = new Set(c.members);
    // Manual symmetric difference -- Set.prototype.symmetricDifference requires
    // ES2025+; project targets ES2022 (per tsconfig.json).
    const drift: string[] = [];
    for (const m of declared) if (!audited.has(m)) drift.push(m);
    for (const m of audited) if (!declared.has(m)) drift.push(m);
    assert.deepStrictEqual(
      drift,
      [],
      `${c.union}: declared members on disk (${[...declared].join(", ") || "<none>"}) differ from CASES.members (${[...audited].join(", ") || "<none>"}). Update both this file and docs/union-audit.md. Drift: ${drift.join(", ") || "<none>"}.`,
    );
    const inert = new Set(c.schemaInert ?? []);
    for (const m of audited) {
      if (inert.has(m)) continue;
      assert.ok(
        forksOutside(m, c.declared) > 0,
        `${c.union}."${m}" has 0 runtime forks outside ${c.declared}. Add a runtime branch or list it under schemaInert.`,
      );
    }
  });
}
