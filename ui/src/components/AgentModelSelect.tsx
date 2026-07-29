import type { AgentDef, FallbackSetOption } from '@shared/types'

/**
 * Reusable agent model selector. Encapsulates the fallback-set dropdown
 * with orphan handling. The selected value encodes the only mode that
 * matters post-providerKey-drop: `set::<name>` resolves to the named
 * fallback set's first entry (the "primary pick"), with per-request
 * failover over the rest of the chain via the GlobalQueue.
 *
 * Switching to a fallback set sends `{ fallbackSet: "<name>" }` and
 * leaves every other agent field untouched (the runtime always derives
 * the dispatch target from fallbackSet, so there's nothing else to
 * update). There is no "pinned model" mode any more: every agent picks
 * a fallback set, and `parseModelSelectValue` returns the same shape
 * regardless of which set the user picks.
 *
 * Orphan-set UI: when an agent's fallbackSet is no longer in the
 * `fallbackSets` map (the migration's orphanCleared branch leaves
 * `fallbackSet` unset, but pre-migration on-disk rows may still carry
 * one), the select renders an explicit
 * `[orphaned: <name>] — Reset PM to recover` disabled option that's
 * selected, so the operator sees the broken state and has a hint to
 * recover. Covers both the typical case (orphan inside the "Fallback
 * sets" optgroup) and the edge case of zero fallback sets configured
 * (orphan rendered at the top level).
 *
 * The full chain (`provider/model → provider/model → ...`) lives in
 * each option's `title` attribute so it's discoverable on hover
 * without consuming dropdown real estate. The visible label is the
 * set name plus the first provider, with a `+N` tail when the chain
 * has additional entries.
 */

export interface AgentModelSelectProps {
  agent: AgentDef
  fallbackSets: Record<string, FallbackSetOption>
  onChange: (value: string) => void
}

export default function AgentModelSelect({
  agent,
  fallbackSets,
  onChange,
}: AgentModelSelectProps): React.JSX.Element {
  const orphan = isOrphaned(agent, fallbackSets)
  const setCount = Object.keys(fallbackSets).length
  const value = agent.fallbackSet ? `set::${agent.fallbackSet}` : ''
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={
        agent.fallbackSet
          ? `Fallback set: ${agent.fallbackSet}` +
            (orphan
              ? ' — orphaned (no longer in config); click Reset PM to recover'
              : ' (runtime uses per-request failover)')
          : 'No fallback set assigned; pick one'
      }
    >
      {setCount > 0 && (
        <optgroup label="Fallback sets (per-request failover)">
          {orphan && (
            <option value={`set::${agent.fallbackSet}`} disabled>
              [orphaned: {agent.fallbackSet}] — Reset PM to recover
            </option>
          )}
          {Object.entries(fallbackSets).map(([name, set]) => (
            <option
              key={`set::${name}`}
              value={`set::${name}`}
              title={set.providers.map((p) => `${p.provider}/${p.model}`).join(' → ')}
            >
              {fallbackSetLabel(name, fallbackSets)}
            </option>
          ))}
        </optgroup>
      )}
      {/* Edge case: orphan agent with no fallback sets configured. The
        optgroup above is gated by `setCount > 0`, so it disappears entirely
        when the user has emptied the fallback-set menu in config. Without
        an explicit orphan option the browser would silently pick the first
        valid set and the operator would lose visibility of the broken
        state. Render the orphan as a top-level option in that case so the
        "[orphaned: <name>]" message is still visible. */}
      {orphan && setCount === 0 && (
        <option value={`set::${agent.fallbackSet}`} disabled>
          [orphaned: {agent.fallbackSet}] — Reset PM to recover
        </option>
      )}
      {!agent.fallbackSet && setCount > 0 && (
        <option value="" disabled>
          — pick a fallback set —
        </option>
      )}
    </select>
  )
}

/** The single shape returned by `parseModelSelectValue`. With the
 *  pinned-model path gone, every select value resolves to a fallback-
 *  set assignment -- there's no second mode. The discriminated union
 *  is kept for forward compat (a future "direct model" override could
 *  add a second `kind`) and so the call site in TeamTab's onModelChange
 *  can be a single explicit `if (patch.kind === 'fallback')`. */
export type ModelPatch = { kind: 'fallback'; fallbackSet: string }

/** Decodes a select value back into a typed patch. Returns `null` for
 *  values that don't match the `set::` prefix (the empty-string
 *  sentinel for "no selection", or any future mode that's not a
 *  fallback set). */
export function parseModelSelectValue(value: string): ModelPatch | null {
  if (value.startsWith('set::')) {
    const name = value.slice('set::'.length)
    if (!name) return null
    return { kind: 'fallback', fallbackSet: name }
  }
  return null
}

/* ----------------------------- private helpers ----------------------------- */

/** True when the agent's fallbackSet is set but the set is no longer in
 *  `fallbackSets` — the migration's orphanCleared branch leaves the
 *  field untouched (only resets pmConfigured), so the runtime would
 *  dispatch to a non-existent set and 503 on every request. Surfaced
 *  from here so other surfaces (the Reset PM button in TeamTab, future
 *  edit forms) can share the same predicate instead of duplicating it. */
export function isOrphaned(agent: AgentDef, fallbackSets: Record<string, FallbackSetOption>): boolean {
  return !!agent.fallbackSet && !fallbackSets[agent.fallbackSet]
}

/** Short label for a fallback set in the dropdown — the set name plus the
 *  first provider, with a "+N" tail when the chain has additional entries.
 *  The full chain (`provider/model → provider/model → ...`) lives in the
 *  option's `title` attribute so it's discoverable on hover without
 *  consuming dropdown real estate. A multi-provider chain like
 *  `complex · anthropic/claude-opus-5 → gemini/models/gemini-3.6-flash →
 *  ollama/qwen2.5:14b-instruct-q4_K_M` would crowd a card-width dropdown
 *  past the next option; the +N form keeps everything one line. */
function fallbackSetLabel(name: string, fallbackSets: Record<string, FallbackSetOption>): string {
  const set = fallbackSets[name]
  if (!set || set.providers.length === 0) return name
  if (set.providers.length === 1) return `${name} · ${set.providers[0].provider}/${set.providers[0].model}`
  return `${name} · ${set.providers[0].provider}/${set.providers[0].model} +${set.providers.length - 1}`
}