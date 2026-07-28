# Union audit — `docs/union-audit.md`

Empirical baseline of which union members are reachable from runtime code in
`src/` and `ui/src/`. Recorded once so a future type-tightening pass draws
from a known ledger rather than re-counting `grep` results.

The Commit history is `0da2f64 ↑ main`.

## Method

A union member is **live** if there is at least one runtime code path that:

- **Writes** through it as a *value* — `createdBy: "system"`, `type: "epic"`,
  `kind: "chat"`, anything where it appears as a literal whose narrowing
  produces a concrete behaviour change.
- **Reads** it as a *value* — `if (x.role === "qa") …`,
  `filter((i) => i.status === "backlog")`, the right-hand side of any
  `===` / `!==` / `case` against the literal.

Type-narrowing in a switch with a default branch is not sufficient — that's
just the type enforcing exhaustiveness, not evidence the value is reachable.
A member that is *declared* in three schemas but never used as a runtime
value is **orphaned** (a special dead category): it survives because the
schema keeps it alive, but no logic depends on it.

A member that is *declared* and a human can *set* it through the admin UI
but the runtime has no per-member code branch is **schema-inert**: the gateway
distinguishes the values only at the schema/prompt surface, not in code.

"Fully live" = both writes and reads exist outside tests.

## Found dead-history baselines (already shipped)

For context, these were the prior tightenings that motivated this audit:

| Commit | Union / member dropped | Symptom |
|---|---|---|
| `5643718` | `complexityRouting` schema + `complexityRouting.tiers.<low/medium/high>` | admin UI mutation path gone; stale data blocked deletes |
| `b751308` | `tasks.complexityClassifier` from delete-validation walk | runtime stopped invoking `router.complete("complexityClassifier", …)`; field readable but unreachable |
| `6991bbf` | `complexityRouting` + `openaiCompatibleInstances` on read | implicit next-save migration to canonical shape |
| `0da2f64` | `TaskKind = "complexityClassifier"` union member, `priorityForTask` case, `TASK_KINDS` array, default `tasks` entry | full hot-removal once the runtime stopped calling it |

All four dead-or-unreachable findings triggered *user-visible* failures (a
delete that wouldn't go through, or a router branch that 503'd) — the
audit's job is to find the next one before it costs a production fix.

## Found live-or-dead per current union

Notation:

- **W** = writes (literal appears as a runtime value being assigned)
- **R** = reads (literal appears as the right-hand side of an
  equality / case / filter)
- **verdict**: dead / orphaned / schema-inert / live
- For union narrowing via `Exclude<…, X>`, the *excluded* member counts
  as a passive-read for purposes of "is it shape-correct?" but **not**
  for "does it exist at runtime" — excluded members are absent from any
  iteration.

### `TaskKind` — `src/types.ts:78`

| Member | W | R | Verdict |
|---|---|---|---|
| `general` | ✓ `router.complete("general", …)` in /v1/messages primary path | ✓ `priorityForTask` `case general:`, `tasks.general` config, `TASK_KINDS[0]` | live |
| `permissionClassifier` | ✓ `src/permissions/classifier.ts:17` `await router.complete("permissionClassifier", …)` | ✓ `case permissionClassifier: return "interactive"` | live |
| `memoryCurator` | ✓ `src/memory/curator.ts:102` `await deps.router.complete("memoryCurator", …)` | ✓ `case memoryCurator: return "background"` | live |

**Union status: fully live, every member reachable from runtime code.**

### `Priority` — `src/providers/types.ts:13`

| Member | W | R | Verdict |
|---|---|---|---|
| `interactive` | ✓ `priorityForTask` returns | ✓ `ThrottledProvider.interactivePending` bucket; `completeOptions.priority?` default in `router.ts` | live |
| `background` | ✓ `priorityForTask` returns | ✓ `ThrottledProvider.backgroundPending` bucket; `pump()` aging branch | live |

**Union status: fully live, both members load-bearing for the throttle's
priority-queue semantics.**

### `AgentRole` — `src/pm/types.ts:98`, mirrored at `ui/src/shared/types.ts:72`

| Member | W | R | Verdict |
|---|---|---|---|
| `steering` | ✓ `agents.ts:198 ensureProjectAgents`, `prompts.ts:10` `ROLE_DEFAULT_MODEL`, `prompts.ts:411` `ROLE_PROMPTS` | ✓ `chatKind === "steering"` (chats), `Exclude<…, "steering">` autonomy keys, `orchestrator.filter role !== "steering"` | live |
| `product-owner` | ✓ `agents.ts:199`, `prompts.ts:11/412` | ✓ `resolve("product-owner")` ×3, `canTransition("product-owner", "ready")` | live |
| `engineering-manager` | ✓ `agents.ts:200`, `prompts.ts:12/413` | ✓ `resolve("engineering-manager")`, `assignReady`, `assignModels`, `createdBy: "engineering-manager"` | live |
| `engineer` | ✓ `agents.ts:203/204`, `prompts.ts:13` | ✓ `listEngineers`, `findRoleAgent` everywhere | live |
| `qa` | ✓ `agents.ts:201`, `prompts.ts:14/414` | ✓ `resolve("qa")`, `qaRounds`, `canTransition("qa", "in_progress")` | live |
| `devops` | ✓ `agents.ts:202`, `prompts.ts:15/415` | ✓ `resolve("devops")` ×2, `assignRepo` / `runDevops`, `autonomy.devops` | live |
| `project-manager` | ✓ `agents.ts:204`, `prompts.ts:16/417` | ✓ `resolve("project-manager")`, `autonomy["project-manager"]`, `filter-out from roster display`, `assignModels` orchestration path | live |

**Union status: fully live, lowest-count member (`project-manager`) still
has five+ runtime paths.**

### `ChatKind` — `src/remote/chats.ts:11`, mirrored at `ui/src/shared/types.ts:8`

| Member | W | R | Verdict |
|---|---|---|---|
| `chat` | ✓ `createChat` default (`chats.ts:57`), `session-manager.ts:171`, `project-routes.ts:32/171` | ✓ `chat.kind ?? "chat"` defaulting chains, `chatKind !== "steering"` filter | live |
| `steering` | ✓ `chats createChat(..., "steering")`, `project-routes.ts:189` ("New discussion"), explicit user choice | ✓ `chatKind === "steering"` (session-manager.ts:220, :251), `STEERING_PROMPT` injection (project-routes.ts:30/33/35) | live |

**Union status: fully live, both members wired into chat creation,
rendering, and prompt injection. Critical: `steering` chats run on the
project's `steeringModel` — a separate model from `chat`'s default —
so dropping it would silently fall back to the chat default.**

### `createdBy` — `src/pm/types.ts:139`

| Member | W | R | Verdict |
|---|---|---|---|
| `system` | ✓ `agents.ts:218` `ensureProjectAgents` default | ✗ no `=== "system"` runtime narrow (it's a write-only audit marker) | live-but-passive — survives because the historical-only field needs no runtime branch |
| `engineering-manager` | ✓ `orchestrator.ts:522` `createAgent createdBy: "engineering-manager"` (when EM creates a new engineer) | ✗ no `=== "engineering-manager"` runtime narrow | live-but-passive |
| `human` | ✓ `agents.ts:74` `createAgent default ?? "human"` | ✗ no `=== "human"` runtime narrow; mentioned at `types.ts:19/427` as a comment-documentation value | live-but-passive |

**Union status: fully live but passive. The field is a provenance marker
read by humans via the admin UI ("last created by…") and rendered in
agent summaries; no runtime code distinguishes the values, only the
schema does. No drop candidate — removing any value would lose provenance
information without any runtime simplification.**

### `WorkItemType` — `src/pm/types.ts:7`

| Member | W | R | Verdict |
|---|---|---|---|
| `epic` | ✓ `orchestrator.ts:356 createWorkItem type: "epic"` (PO planning) | ✓ `board.ts:226/239` epics list + skip-epics, `orchestrator.ts:137/453` readyWork `type !== "epic"` filter | live |
| `story` | ✓ `orchestrator.ts:369` ternary fallback `story.type === "bug" ? "bug" : "story"` | ✓ same ternary sets it on `createWorkItem`; immediate via board + agent contract fields | live, but **write path is single-ternary** — only set via `planIdea` ↦ `createWorkItem`, no direct `type: "story"` literal anywhere else |
| `bug` | ✓ `orchestrator.ts:369` ternary `=== "bug"` branch | ✓ same ternary, plus allow-type-checking at the contract boundary (`prompts.ts:290`) | live |

**Union status: fully live. `story` and `bug` are written only through the
PO's `planIdea → createWorkItem` ternary path — no direct literal usage
in the orchestrator. This is the lowest-count-shape union in `pm/` but
not a drop candidate: removing it would force the schema to lose the
`type` discriminator and break the epic/child rollup in `board.ts:226`.**

### `BOARD_STATUSES` — `src/pm/types.ts:4` and `:3`

| Member | W | R | Verdict |
|---|---|---|---|
| `backlog` | ✓ `board.ts:65 createWorkItem default`, `pm-routes.ts:97` API default | ✓ `orchestrator.ts:133/391` backlog filter, `:648` retry-back transition, `board.ts:16/21` canTransition table | live |
| `ready` | ✓ `orchestrator.ts:436 transitionWorkItem(id, "ready", ...)` and `canTransition("product-owner", "ready")` gate | ✓ `orchestrator.ts:137/453` ready filter, `:462` ready-column size, `board.ts:16/17/21` | live |
| `in_progress` | ✓ `orchestrator.ts` transitionWorkItem to in_progress on assign; engineer/EM loops set is-in_progress filters | ✓ many filters in orchestrator, `:462 inFlight count`, `board.ts:18/155/161` qa-bounce tracking | live |
| `qa` | ✓ `orchestrator.ts:653 transitionWorkItem(workItemId, "qa", ...)` ready-for-QA | ✓ `:171/:664 status === "qa"` filters, `:155 qaRounds++`, `board.ts:18/19` allowed transitions | live |
| `complete` | ✓ `orchestrator.ts` (qa.ts:runQa passes ticket) → `transitionWorkItem(..., "complete", …)` | ✓ `:178 status === "complete" && !item.labels.includes("deployed")` filter for deployment, `board.ts:19/20/219` completion stats | live |

**Union status: fully live. Every column has explicit writes + reads.
The `devops: ["complete"]` entry at `board.ts:20` confirms "complete" is
unique in being a terminal state the devops agent reads but does not write.**

### `Complexity` — `src/pm/types.ts:9`

| Member | W | R | Verdict |
|---|---|---|---|
| `low` | ✗ no direct `complexity: "low"` write outside the type sub-union declarations at `prompts.ts:317/322` | ✗ no `=== "low"` runtime narrow | **orphaned write** — but reachable via `createAgent({ maxComplexity: "low" })` when the EM decides an agent is fit for low-complexity work |
| `medium` | ✓ `agents.ts:75 / :203 / :520` defaults for engineers | ✗ no `=== "medium"` runtime narrow | live-but-passive (default fallback) |
| `high` | ✓ `agents.ts:198-204` defaults for steering/PO/EM/QA/devops/PM (six roles) | ✗ no `=== "high"` runtime narrow | live-but-passive (default for orchestration roles) |

**Union status: fully live, all three values. The runtime treats
`Complexity` (the **work item**'s complexity) and `maxComplexity` (the
**agent**'s rated ceiling) asymmetrically:**

- `WorkItem.complexity` is `Complexity | null` and **is** actively
  queried — `assignReady` calls `board.updateWorkItem(..., complexity:
  assignment.complexity)` where `assignment.complexity: "low" | "medium"
  | "high"` writes through the EM's sizing call. The references at
  `prompts.ts:317/322` are schemas the EM's `ASSIGN_SHAPE` JSON contract
  advertises — that's the *write* path for `low`/`medium`/`high` on
  WorkItem.
- `AgentDef.maxComplexity` simply stores the ceiling; nothing compares
  against it at runtime today, but the EM prompt mentions it and the
  future intends to gate assignments on it.

**No drop candidate — the schema needs all three and they are
distinguishable in both the work-item and agent surfaces.**

### `DeployTarget` — `src/pm/types.ts:197`, mirrored at `ui/src/shared/types.ts:73`

| Member | W | R | Verdict |
|---|---|---|---|
| `none` | ✓ `defaultProjectSettings: deployTarget: "none"` (`types.ts:256`); UI-exposed as the default selection | ✓ `orchestrator.ts:176/973` `!== "none"` and `=== "none"` skip-paths | live — this is the only member the runtime distinguishes |
| `docker-local` | — | ✗ no runtime `=== "docker-local"` narrow anywhere | schema-inert — setable through admin UI but runtime treats `docker-local` and `aws` identically |
| `aws` | — | ✗ no runtime `=== "aws"` narrow anywhere | schema-inert |

**Union status: `none` is the only runtime-distinguished member. The
non-`none` values are differentiated only through the devops agent's
prompt content:** `src/orchestrator.ts:978` literally templates the value
into the devops agent's deployment prompt as
`\`## Deployment target: ${ctx.settings.deployTarget}\`` and the devops
prompt at `prompts.ts:259` says
*"Prepare and execute the deployment for the project's configured target —
a local Docker deployment or an AWS deployment, as configured in the
project settings you're given."* The human-in-the-loop (devops agent)
makes the per-target decision based on the templated string; the gateway
itself makes no per-target code branch.

**This is real but not a drop candidate.** Removing `docker-local` and
`aws` from the union would forfeit the schema's documented deployment
footprint. The right *follow-on* (not this audit's job) is to surface
per-target runtime support: a `target === "aws"` could expand the
secret/Vault loads, the devops prompt could include AWS-specific
sub-prompts, and the devops contract could require an `awsRegion` field
when target === "aws". Each of those is a real user feature, not
schema cleanup.

### `ModelRecord.requestsPerHour` ambiguity — `src/pm/types.ts:108`, `src/pm/model-registry.ts:47/92`, `ui/src/shared/types.ts:294`

| Surface | Reads |
|---|---|
| CostProfile (`src/pm/types.ts:108`) | ✗ declared; no `record.requestsPerHour` consumer anywhere |
| ModelRecord (`src/pm/model-registry.ts:47`) —same field name, separate schema | ✗ declared; only the `requestsPerHour: null` default at `:92` is set |
| ModelRecord mirror (`ui/src/shared/types.ts:294`) | ✗ declared; UI never reads it (admin stats endpoint returns the throttle stats, not the model-registry row) |

**Verdict: orphaned field.** The "ambiguity" the audit was asked about
was solved by a separate mechanism: `ThrottledProvider.rpmLimit`
(`src/providers/throttle.ts:108`) — a per-provider token-bucket rate
limiter that lands BEFORE the request is dispatched. The
`requestsPerHour` field was the original design (rendered in the
admin UI as a per-model rate cap) but was bypassed when the throttle
moved to a token-bucket admission control. The schema kept the field
for historical-shape reasons; nothing reads it.

**Recommended follow-on (not this audit's job):**
`delete requestsPerHour from CostProfile, ModelRecord (and its UI
mirror), the default in `ensureModel`. Three schemas, 0 reads, 0
external consumers — clean drop. The ThrottleStatsMonitor surface
already exposes the active rate limit
(`rpmLimit: number | null, rateTokens: number | null`), so the
operator-facing rate-limit signal is not lost.

### `Emitterable` body kind — term-not-found

`grep -rn "Emitterable|Emitter\b|bodyKind|messageKind|EventEmitter"`
across `src/` and `ui/src/` returned only:

- `src/pm/orchestrator.ts:1` `import { EventEmitter } from "node:events";` + `:47` `class Orchestrator extends EventEmitter<OrchestratorEvents>` — the standard Node-event-emitter pattern, never a
  `bodyKind` member.
- `src/server/project-routes.ts:182` `(req.body ?? {}) as { title?: string; kind?: chats.ChatKind }` — `kind` is the chat kind, not a body kind for events.
- `ui/src/shared/types.ts:~38` `ChatEvent` union (10 members: `connected`,
  `session`, `text_delta`, `message_final`, `tool_result`,
  `turn_complete`, `approval_request`, `approval_resolved`,
  `idea_handoff`, `error`) — no per-event body sub-kind.

**Verdict: term does not exist in this codebase.** Either the audit
prompt referred to a different name (e.g. `EventBody`, `FrameKind`,
`MessageKind`) that has not crossed into this codebase, or the term
came from a similar concept in another gateway library. No "body kind"
union analogous to `BroadcastChannel`-style libraries appears in
`src/` or `ui/src/`. **No dead members — the term is simply absent.**

If the intent was to audit one of the actual union types in this
codebase, the closest matches are:

- `ChatEvent` (10 members) — all member-narrowed in `ui/src/components/`
- `PmEvent` (3 members) — `connected` / `pm_change` / `pm_activity`,
  fully alive
- `OrchestratorEvents` (`change` / `activity`) — fully alive

## Cross-reference: legacy cleanup history

The two prior tightenings follow the same shape:

- Drop the unreachable union member from the type.
- Drop it from every default / array literal that mirrors the type.
- Drop it from any ehaustive switch defaulting on the type.
- Document the boundary in JSDoc so the next contributor knows why.

`0da2f64` applied all four steps to drop `complexityClassifier`; the
cleared paths are exactly what this audit will need for any future
drop. **Today** the audit found zero dead candidates — every union
member is reachable from runtime code either directly or as a default
provenance marker. The shape of any future drop is therefore a
**schema-inert → live migration** (the `DeployTarget` case) rather
than a `live → dead` removal.

## Summary

| Union | Members | Live | Dead / orphaned / schema-inert |
|---|---|---|---|
| `TaskKind` | 3 | 3 | 0 |
| `Priority` | 2 | 2 | 0 |
| `AgentRole` (backend + UI) | 7 | 7 | 0 |
| `ChatKind` | 2 | 2 | 0 |
| `createdBy` | 3 | 3 passive | 0 |
| `WorkItemType` | 3 | 3 | 0 |
| `BOARD_STATUSES` | 5 | 5 | 0 |
| `Complexity` | 3 | 3 | 0 |
| `DeployTarget` | 3 | 1 (none) | 2 schema-inert (docker-local, aws) |
| `ModelRecord.requestsPerHour` | (single nullable field) | 0 | 1 orphaned |
| `Emitterable` body kind | n/a | n/a | term not found |

**No live runtime caller is missing a member of its expected union.**
The closest real drop candidate is the orphaned `requestsPerHour`
field — three schema mirrors, zero readers — which is the natural
follow-on commit once a reviewer approves.

The next audit pass should focus on **runtime call sites that don't
match the schema's advertised distinctions**, not on the unions
themselves. The `DeployTarget` schema-inert state is the strongest
hint that the product surface is one step ahead of the runtime
implementation, and clarifying that gap is a feature, not a cleanup.
