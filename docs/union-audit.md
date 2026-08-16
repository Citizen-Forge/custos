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
| `principal` | ✓ `agents/bootstrap.ts` `ensureProjectAgents` seed entry, `prompts/defaults.ts` `ROLE_DEFAULT_FALLBACK_SET.principal = "principal"` | ✓ `agents/store.ts findRoleAgent(projectId, "principal")` (`orchestrator/escalation.ts`), `agents/mutate.ts assertFallbackSetAllowed` role-lock, `board.ts ROLE_TRANSITIONS.principal`, `slack/personas.ts ROLE_PERSONAS.principal`, excluded from `listEngineers()`'s roster and from the EM's/PM's fallback-set menus (`orchestrator/engineering-manager.ts`, `orchestrator/project-manager.ts`) | live |
| `principal-qa` | ✓ `agents/bootstrap.ts` `ensureProjectAgents` seed entry, `prompts/defaults.ts` `ROLE_DEFAULT_FALLBACK_SET["principal-qa"] = "principal"` (shares the same locked set as `principal`) | ✓ `agents/store.ts findRoleAgent(projectId, "principal-qa")` (`orchestrator/escalation.ts`'s QA branch), read back per-ticket via `WorkItem.qaAssigneeAgentId` → `pm-prompts.ts resolveSpecificAgent` (`orchestrator/qa.ts runQa`), `agents/mutate.ts assertFallbackSetAllowed` role-lock (shared list with `principal`), `board.ts ROLE_TRANSITIONS["principal-qa"]`, `slack/personas.ts ROLE_PERSONAS["principal-qa"]`, excluded from the EM's/PM's fallback-set menus and the PM's roster | live |

**Union status: fully live, lowest-count member (`project-manager`) still
has five+ runtime paths. `principal` and `principal-qa` are both
deliberately excluded from every normal assignment path (EM roster, PM
reassignment) — their only write paths are the escalation stage's
deterministic reassignment after 5 consecutive failed attempts (engineer-
side for `principal`, QA-side for `principal-qa`, both in
`orchestrator/escalation.ts`), gated by `agents/mutate.ts`'s
`assertFallbackSetAllowed` so no other role can be handed their shared
(real-Anthropic-usage) `principal` fallback set. `principal-qa` is the one
role resolved per-ticket rather than per-project (`WorkItem.qaAssigneeAgentId`),
since a project has exactly one QA agent but escalation needs to target a
specific ticket without disturbing every other ticket still in `qa`.**

### `ChatKind` — `src/remote/chats.ts:11`, mirrored at `ui/src/shared/types.ts:8`

| Member | W | R | Verdict |
|---|---|---|---|
| `chat` | ✓ `createChat` default (`chats.ts:57`), `session-manager.ts:171`, `project-routes.ts:32/171` | ✓ `chat.kind ?? "chat"` defaulting chains, `chatKind !== "steering"` filter | live |
| `steering` | ✓ `chats createChat(..., "steering")`, `project-routes.ts:189` ("New discussion"), explicit user choice | ✓ `chatKind === "steering"` (session-manager.ts:220, :251), `STEERING_PROMPT` injection (project-routes.ts:30/33/35) | live |
| `portfolio` | ✓ `chats.listChats(undefined, "portfolio")` / `createChat(null, ..., "portfolio")` (`project-routes.ts:177/188`) — the one kind not scoped to a project, `projectId: null` | ✓ `project-routes.ts:35` `if (kind === "portfolio") return { appendSystemPrompt: PORTFOLIO_PROMPT, mcpConfig: buildPortfolioMcpConfig() }`, `session-manager.ts` null-projectId handling documented at `:51/:68/:274` | live |

**Union status: fully live, all three members wired into chat creation,
rendering, and prompt injection. Critical: `steering` chats run on the
project's `steeringModel` — a separate model from `chat`'s default —
so dropping it would silently fall back to the chat default.
`portfolio` is the only kind not scoped to a single project (`projectId:
null`) — it's the cross-project assistant chat, routed to
`PORTFOLIO_PROMPT` and its own MCP config rather than any project's
tools.**

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
| `none` | ✓ `defaultProjectSettings: deployTarget: "none"` (`types.ts:256`); UI-exposed as the default selection | ✓ `orchestrator.ts:176/973` `!== "none"` and `=== "none"` skip-paths | live |
| `docker-local` | ✓ injected into `deploymentTargetSection` (`orchestrator.ts`) — the runtime switch injects compose-file-specific guidance into the devops agent's prompt | ✓ `case "docker-local":` in `deploymentTargetSection`; runtime branch on each value rather than string-templating | live |
| `aws` | ✓ injected into `deploymentTargetSection` (`orchestrator.ts`) — same per-target branch as docker-local, with aws-region-specific sub-prompt | ✓ `case "aws":` in `deploymentTargetSection`; post-result runtime enforcement `if (ctx.settings.deployTarget === "aws" && !contract.awsRegion` in `runDevops` | live |

**Union status: fully live.** Each member has a runtime fork — the gate
that lets the deploy proceed differs per target through
`deploymentTargetSection` and the AWS contract requires
`awsRegion` as an audit trail. The devops agent's prompt content is now
target-specific, not generic.

The orchestrator's `deploymentTargetSection(target, deployConfig)`
helper is what unblocked the audit: each per-target branch is a real
code path keyed on the union value, not a templated string. The AWS
post-result enforcement (`!== aws with empty awsRegion ⟶ blocked`) is
the runtime narrow the audit was looking for. `DevopsContract`
(`contracts.ts:80`) gained an optional `awsRegion?: string | null`
field that is required-when-AWS at runtime but kept loose on the type
because the LLM contract is loose by design; the runtime enforcement
is what makes it required.

### `ModelRecord.requestsPerHour` ambiguity — DROPPED in follow-up commit

**Status:** removed from `CostProfile` (`src/pm/types.ts`),
`ModelRecord` (`src/pm/model-registry.ts`), the `ensureModel()` default,
and the UI mirror (`ui/src/shared/types.ts`). The field had three
schema mirrors and zero readers; the active per-provider rate limit
moved to `ThrottledProvider.rpmLimit`
(`src/providers/throttle.ts:108`) which carries the operator-facing
signal (`rpmLimit: number | null`, `rateTokens: number | null` in
`ThrottleStats`).

See git history for the `<chore>` commit that removed all four
declarations plus the `requestsPerHour: null` default in
`ensureModel`. Recorded here so a future reviewer checking this audit
ledger sees the resolution rather than re-hunting the orphan.

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
provenance marker. The shape of any future drop would still need a
schema-inert → live migration pattern, but the
`DeployTarget.docker-local`/`DeployTarget.aws` row of this audit is
already resolved — both members have explicit runtime branches in
`deploymentTargetSection` and (for AWS) the `awsRegion` contract
enforcement. The "next schema-inert finding" template is committed
to the codebase now: when the audit names a schema-inert union
member, the fix is to give it a runtime fork keyed on the value,
update the audit doc + test together, and document the rationale.

## Summary

| Union | Members | Live | Dead / orphaned / schema-inert |
|---|---|---|---|
| `TaskKind` | 3 | 3 | 0 |
| `Priority` | 2 | 2 | 0 |
| `AgentRole` (backend + UI) | 9 | 9 | 0 |
| `ChatKind` | 3 | 3 | 0 |
| `createdBy` | 3 | 3 passive | 0 |
| `WorkItemType` | 3 | 3 | 0 |
| `BOARD_STATUSES` | 5 | 5 | 0 |
| `Complexity` | 3 | 3 | 0 |
| `DeployTarget` | 3 | 3 | 0 |
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
