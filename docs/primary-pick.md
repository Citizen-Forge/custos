# Primary pick contract

The `AgentDef.providerKey` and `AgentDef.model` fields are the
**operator-facing "primary pick"** of an agent — they show up in the
admin UI's agent badge tooltip and are what the human reads when
checking "what will this agent actually use at request time?"

The relationship to `AgentDef.fallbackSet` is exact:

> **Primary pick == first live entry of the fallback set.**

Formal justification:

- The runtime dispatches every request through `custos:fallback/<set-name>`
  when `fallbackSet` is set (`agent-runner.ts` → `model-alias.ts` → `runtime.completeWithFallback()`).
  The `providerKey`/`model` field is read by no part of the dispatch
  pipeline once `fallbackSet` is set.
- The fallback set's first entry is the highest-priority provider in
  the chain. Showing it as the "primary pick" matches what the operator
  sees when the chain is healthy (the first entry serves the request).
- When the first entry is unavailable (cooldown, rate limit, concurrency
  cap), the GlobalQueue falls through to the next entry — but the
  primary pick display still shows the first entry, because that's the
  intent ("we wanted anthropic first; we got ollama"). The runtime
  surface tells the operator which entry actually served the request
  (the `providerKey` from the resolved request stats).

## Migration

`migrateToFallbackSets(config)` in `src/pm/agents.ts` runs on every
container startup. It has two responsibilities:

1. **Assign role-default fallback sets** to agents missing one.
2. **Normalize primary pick** — for every agent with a fallbackSet,
   set `providerKey`/`model` to the first entry of
   `config.fallbackSets[setName].providers`.

The second pass is what closed the "stale primary pick" gap. Before
normalization, agents created by `ensureProjectAgents` carried
`anthropic/claude-sonnet-5` regardless of which fallback set the
Project Manager later picked — the UI then showed a stale claude-Sonnet
hint for an agent that was actually meant to run on the fallback set's
first entry.

## Edge cases

| Condition | Behavior |
|---|---|
| Agent has fallbackSet that no longer exists in config | Stale primary pick is left in place; pmConfigured is reset for the project so the PM re-runs and picks a valid set. Without the reset, the agent would dispatch to a non-existent set indefinitely and the runtime would 503 on every request. |
| Agent has fallbackSet with empty `providers` array | Same as the orphan-set case: stale primary pick is left in place, pmConfigured is reset. |
| Agent already has correct primary pick | No-op (idempotent). |
| Agent has fallbackSet but providerKey/model match the set's first entry | No-op. |
| Pure normalization (no fallbackSet changes) | pmConfigured is NOT reset — the PM's decisions are about fallbackSet selection, not primary pick. |
| FallbackSet change AND primary pick change | Both updates applied; pmConfigured IS reset for the project. |

## What this is NOT

- This is **not** a runtime dispatch change. The runtime already used
  `fallbackSet` exclusively; the normalization is a UI honesty fix.
- This is **not** a per-ticket model override. The engineering manager
  still picks agents (and through them, fallback sets) per ticket via
  `assignReady`. The primary pick is a static per-agent display value.
- This is **not** automatic -- the pmConfigured reset is the
  discovery mechanism. If an operator manually edits a fallback set's
  first entry, agents' primary picks don't update until the next
  container restart.
