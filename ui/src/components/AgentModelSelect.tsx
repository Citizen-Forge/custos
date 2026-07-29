import type { AgentDef, FallbackSetOption, ProviderOption } from '@shared/types'

/**
 * Reusable agent model selector. Encapsulates the fallback-set-aware
 * dropdown with orphan handling plus the legacy "pinned model" mode
 * (the engineering manager's ad-hoc engineer authoring and operators
 * who want to pin a specific model).
 *
 * The selected value encodes the mode with a `set::` or `model::` prefix
 * so the consumer can read the mode back without guessing:
 *   - `set::<name>` → fallback set dispatch (per-request failover)
 *   - `model::<provider>::<model>` → direct provider/model (legacy)
 *
 * Switching to a fallback set sends `{ fallbackSet: "<name>" }` and
 * leaves providerKey/model untouched (the migration normalizes them
 * on next boot to satisfy the primary-pick contract). Switching to a
 * direct model sends `{ fallbackSet: null, providerKey, model }` so
 * the runtime drops back to the pinned path.
 *
 * Orphan-set UI: when an agent's fallbackSet is no longer in the
 * `fallbackSets` map (the migration's orphanSet branch leaves the
 * field untouched and only resets pmConfigured), the select renders
 * an explicit `[orphaned: <name>] — Reset PM to recover` disabled
 * option that's selected, so the operator sees the broken state and
 * has a hint to recover. Covers both the typical case (orphan inside
 * the "Fallback sets" optgroup) and the edge case of zero fallback
 * sets configured (orphan at the top level).
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
  /** Direct provider/model options listed under the "Pinned model" optgroup. */
  providerOptions: ProviderOption[]
  onChange: (value: string) => void
}

export default function AgentModelSelect({
  agent,
  fallbackSets,
  providerOptions,
  onChange,
}: AgentModelSelectProps): React.JSX.Element {
  const isOrphaned = !!agent.fallbackSet && !fallbackSets[agent.fallbackSet]
  const setCount = Object.keys(fallbackSets).length
  return (
    <select
      value={modelSelectValue(agent)}
      onChange={(e) => onChange(e.target.value)}
      title={agent.fallbackSet
        ? `Fallback set: ${agent.fallbackSet}` +
          (isOrphaned ? ' — orphaned (no longer in config); click Reset PM to recover' : ' (runtime uses per-request failover)')
        : `Pinned: ${agent.providerKey}/${agent.model}`}
    >
      {setCount > 0 && (
        <optgroup label="Fallback sets (per-request failover)">
          {isOrphaned && (
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
        direct model and the operator would lose visibility of the broken
        state. Render the orphan as a top-level option in that case so the
        "[orphaned: <name>]" message is still visible. */}
      {isOrphaned && setCount === 0 && (
        <option value={`set::${agent.fallbackSet}`} disabled>
          [orphaned: {agent.fallbackSet}] — Reset PM to recover
        </option>
      )}
      <optgroup label="Pinned model (no fallback)">
        {optionsIncluding(providerOptions, agent).map((option) => (
          <option
            key={`model::${option.providerKey}::${option.model}`}
            value={`model::${option.providerKey}::${option.model}`}
          >
            {option.providerKey} / {option.model}
            {option.free ? ' (free)' : ''}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

/** Discriminated union returned by `parseModelSelectValue`. Two modes
 *  match the two operational modes the agent can be in: fallback-set
 *  dispatch or pinned provider/model. Forcing the caller to handle
 *  both via a `kind` switch keeps the two modes explicit at every
 *  call site, instead of letting `null` vs `undefined` distinctions
 *  drift across consumers. */
export type ModelPatch =
  | { kind: 'fallback'; fallbackSet: string }
  | { kind: 'pinned'; providerKey: string; model: string };

/** Decodes a select value back into a typed patch. Returns `null` for
 *  values that don't match either prefix (shouldn't happen for value
 *  events from the select, but the parser is defensive). */
export function parseModelSelectValue(value: string): ModelPatch | null {
  if (value.startsWith('set::')) {
    return { kind: 'fallback', fallbackSet: value.slice('set::'.length) };
  }
  if (value.startsWith('model::')) {
    const [, providerKey, model] = value.split('::');
    return { kind: 'pinned', providerKey, model };
  }
  return null;
}

/* ----------------------------- private helpers ----------------------------- */

/** Encodes the agent's current selection into a `set::name` or
 *  `model::provider::model` value that the select can match against
 *  its options. */
function modelSelectValue(agent: AgentDef): string {
  if (agent.fallbackSet) return `set::${agent.fallbackSet}`;
  return `model::${agent.providerKey}::${agent.model}`;
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
  const set = fallbackSets[name];
  if (!set || set.providers.length === 0) return name;
  if (set.providers.length === 1) return `${name} · ${set.providers[0].provider}/${set.providers[0].model}`;
  return `${name} · ${set.providers[0].provider}/${set.providers[0].model} +${set.providers.length - 1}`;
}

/** The agent's current pairing may not be in the live menu (a provider was
 *  removed from gateway config after the operator picked it). Include it
 *  anyway so the select shows the truth rather than silently snapping to
 *  another model. */
function optionsIncluding(options: ProviderOption[], agent: AgentDef): ProviderOption[] {
  if (options.some((o) => o.providerKey === agent.providerKey && o.model === agent.model)) return options;
  return [
    { providerKey: agent.providerKey, model: agent.model, free: false, inputPerMTok: null, outputPerMTok: null, budgetUsd: null },
    ...options,
  ];
}
