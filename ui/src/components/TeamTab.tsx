import { useCallback, useEffect, useState } from 'react'
import type { ActivityResponse, AgentDef, AgentsResponse, CustosProject, FallbackSetOption, ProviderOption } from '@shared/types'
import { useCall, relativeTime } from '../api'
import Avatar, { agentLabel } from './Avatar'

/**
 * Agent roster and run activity — the team that works on this project, who's
 * active right now, and what they've been doing. Moved out of the DevOps tab
 * into its own tab so the engineering manager can glance at agent status and
 * recent runs without leaving the board or scrolling through deployment config.
 */
export default function TeamTab({
  project,
  revision
}: {
  project: CustosProject
  revision: number
}): React.JSX.Element {
  const call = useCall()
  const [activity, setActivity] = useState<ActivityResponse | null>(null)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])
  const [fallbackSets, setFallbackSets] = useState<Record<string, FallbackSetOption>>({})

  const refresh = useCallback(async () => {
    const [activityRes, agentsRes] = await Promise.all([
      call<ActivityResponse>('GET', `/admin/api/projects/${project.id}/activity`),
      call<AgentsResponse>('GET', `/admin/api/projects/${project.id}/agents`),
    ])
    if (activityRes) setActivity(activityRes)
    if (agentsRes) {
      setAgents(agentsRes.agents)
      setProviderOptions(agentsRes.providerOptions)
      setFallbackSets(agentsRes.fallbackSets ?? {})
    }
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function patchAgent(agent: AgentDef, update: Partial<AgentDef>): Promise<void> {
    await call('PATCH', `/admin/api/agents/${agent.id}`, update)
    refresh()
  }

  /** The Model dropdown is the primary UI for an agent's dispatch choice.
   *  It's a single select with two optgroups: fallback sets (preferred —
   *  the runtime uses these for per-request failover) and direct
   *  provider/model pairs (the legacy mode, kept for the EM's ad-hoc
   *  engineer authoring and for operators who want to pin a specific model).
   *  The selected value encodes the mode with a `set::` or `model::` prefix
   *  so the onChange handler can read the mode back without guessing. */
  function modelSelectValue(agent: AgentDef): string {
    if (agent.fallbackSet) return `set::${agent.fallbackSet}`
    return `model::${agent.providerKey}::${agent.model}`
  }

  /** When an agent's fallbackSet is no longer in config (the migration's
   *  orphanSet branch leaves the agent's field untouched and only resets
   *  pmConfigured), the select would silently pick some unrelated option.
   *  Render an explicit `[orphaned: <name>]` option so the operator sees
   *  the inconsistency and triggers a Reset PM to recover. */
  function isOrphaned(agent: AgentDef): boolean {
    return !!agent.fallbackSet && !fallbackSets[agent.fallbackSet]
  }

  function onModelChange(agent: AgentDef, value: string): void {
    if (value.startsWith('set::')) {
      const fallbackSet = value.slice('set::'.length)
      // Send the new fallbackSet WITHOUT touching providerKey/model —
      // the migration keeps those fields as the "primary pick" pointer
      // matching the fallback set's first entry, so leaving them alone
      // here keeps the contract (primary pick == first live entry)
      // honest without forcing a re-derivation on every UI edit.
      void patchAgent(agent, { fallbackSet })
    } else if (value.startsWith('model::')) {
      const [, providerKey, model] = value.split('::')
      // Switching to a direct model clears the fallbackSet explicitly so
      // the agent card dropdown reverts to the legacy display and the
      // runtime drops back to the pinned providerKey/model path.
      void patchAgent(agent, { fallbackSet: null, providerKey, model })
    }
  }

  /** Short label for a fallback set in the dropdown — the set name plus the
   *  first provider, with a "+N" tail when the chain has additional entries.
   *  The full chain (`provider/model → provider/model → ...`) lives in the
   *  option's `title` attribute so it's discoverable on hover without
   *  consuming dropdown real estate. A multi-provider chain like
   *  `complex · anthropic/claude-opus-5 → gemini/models/gemini-3.6-flash →
   *  ollama/qwen2.5:14b-instruct-q4_K_M` would crowd a card-width dropdown
   *  past the next option; the +N form keeps everything one line. */
  function fallbackSetLabel(name: string): string {
    const set = fallbackSets[name]
    if (!set || set.providers.length === 0) return name
    if (set.providers.length === 1) return `${name} · ${set.providers[0].provider}/${set.providers[0].model}`
    return `${name} · ${set.providers[0].provider}/${set.providers[0].model} +${set.providers.length - 1}`
  }

  return (
    <div className="devops">
      {/* Agent roster -------------------------------------------------- */}
      <section className="panel">
        <h2>Agents</h2>
        <div className="agent-grid">
          {agents.map((agent) => (
            <article className={`agent-card${agent.active ? '' : ' inactive'}`} key={agent.id}>
              <div className="agent-head">
                <Avatar name={agentLabel(agent)} size={24} />
                <strong>{agentLabel(agent)}</strong>
                <span className="badge">{agent.role}</span>
                {agent.createdBy === 'engineering-manager' && <span className="badge">EM-created</span>}
              </div>
              <label className="field inline">
                <span>Model</span>
                <select
                  value={modelSelectValue(agent)}
                  onChange={(e) => onModelChange(agent, e.target.value)}
                  title={agent.fallbackSet
                    ? `Fallback set: ${agent.fallbackSet}` +
                      (isOrphaned(agent) ? ' — orphaned (no longer in config); click Reset PM to recover' : ' (runtime uses per-request failover)')
                    : `Pinned: ${agent.providerKey}/${agent.model}`}
                >
                  {Object.keys(fallbackSets).length > 0 && (
                    <optgroup label="Fallback sets (per-request failover)">
                      {isOrphaned(agent) && (
                        <option value={`set::${agent.fallbackSet}`} disabled>
                          [orphaned: {agent.fallbackSet}] — Reset PM to recover
                        </option>
                      )}
                      {Object.entries(fallbackSets).map(([name, set]) => (
                        <option key={`set::${name}`} value={`set::${name}`} title={set.providers.map((p) => `${p.provider}/${p.model}`).join(' → ')}>
                          {fallbackSetLabel(name)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* Edge case: orphan agent with no fallback sets configured.
                    The optgroup above is gated by `fallbackSets.length > 0`,
                    so it disappears entirely when the user has emptied the
                    fallback-set menu in config. Without an explicit orphan
                    option the browser would silently pick the first direct
                    model and the operator would lose visibility of the
                    broken state. Render the orphan as a top-level option in
                    that case so the "[orphaned: <name>]" message is still
                    visible and the "Reset PM to recover" hint still says. */}
                  {isOrphaned(agent) && Object.keys(fallbackSets).length === 0 && (
                    <option value={`set::${agent.fallbackSet}`} disabled>
                      [orphaned: {agent.fallbackSet}] — Reset PM to recover
                    </option>
                  )}
                  <optgroup label="Pinned model (no fallback)">
                    {optionsIncluding(providerOptions, agent).map((option) => (
                      <option key={`model::${option.providerKey}::${option.model}`} value={`model::${option.providerKey}::${option.model}`}>
                        {option.providerKey} / {option.model}
                        {option.free ? ' (free)' : ''}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              {agent.specialty && <div className="agent-specialty">{agent.specialty}</div>}
              <div className="agent-stats">
                {agent.stats.assigned} assigned · {agent.stats.completed} done · {agent.stats.qaRejections} bounced · $
                {agent.stats.totalCostUsd.toFixed(2)}
              </div>
              {agent.notes.length > 0 && (
                <ul className="agent-notes">
                  {agent.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* Activity log -------------------------------------------------- */}
      <section className="panel">
        <h2>Activity</h2>
        {activity?.active.length ? (
          <div className="running-list">
            {activity.active.map((run) => {
              const timeSinceLastEvent = Date.now() - run.lastEventAt
              const stalled = activity.stalledRunIds.includes(run.id)
              const status: 'running' | 'waiting' | 'stalled' =
                stalled ? 'stalled' :
                timeSinceLastEvent < 120_000 ? 'running' :
                'waiting'
              const statusBadge = {
                running: <span className="badge working">running</span>,
                waiting: <span className="badge warn">waiting</span>,
                stalled: <span className="badge stalled">no activity</span>,
              }[status]
              const statusHint = {
                running: 'actively processing',
                waiting: 'waiting in queue for provider',
                stalled: 'no events for over 6 minutes — may be hung',
              }[status]
              return (
                <div key={run.id} className={`running-row${stalled ? ' stalled' : status === 'waiting' ? ' waiting' : ''}`}>
                  <div className="running-head">
                    {statusBadge}
                    <strong>{run.role}</strong>
                    <span className="muted">
                      {run.providerKey}/{run.model}
                    </span>
                    <span className="muted">started {relativeTime(run.startedAt)}</span>
                    <span className="muted">{run.toolCalls} tool calls</span>
                  </div>
                  <div className="running-action">
                    {run.currentAction
                      ? run.currentAction
                      : status === 'waiting'
                        ? <span className="muted">waiting for an available provider slot…</span>
                        : <span className="muted">thinking…</span>
                    }
                    <span className="muted" title={statusHint}>
                      {' · '}last moved {relativeTime(run.lastEventAt)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
        {!activity?.runs.length && <p className="hint">Nothing has run yet.</p>}
        {activity?.runs.map((run) => (
          <details key={run.id} className={`run run-${run.status}`}>
            <summary>
              <span className={`badge ${run.status}`}>{run.status}</span>
              <span className="run-role">{run.role}</span>
              <span className="muted">
                {run.providerKey}/{run.model}
              </span>
              <span className="muted">{relativeTime(run.startedAt)}</span>
              {run.costUsd ? (
                <span className="muted">
                  ${run.costUsd.toFixed(3)}
                  {run.billed ? '' : ' (subscription)'}
                </span>
              ) : null}
            </summary>
            {run.error && <div className="card-error">{run.error}</div>}
            <pre className="run-summary">{run.summary || '(no output)'}</pre>
          </details>
        ))}
      </section>
    </div>
  )
}

/** The agent's current pairing may not be in the live menu (a provider was
 * removed from gateway config after the EM picked it). Include it anyway so
 * the select shows the truth rather than silently snapping to another model. */
function optionsIncluding(options: ProviderOption[], agent: AgentDef): ProviderOption[] {
  if (options.some((o) => o.providerKey === agent.providerKey && o.model === agent.model)) return options
  return [{ providerKey: agent.providerKey, model: agent.model, free: false, inputPerMTok: null, outputPerMTok: null, budgetUsd: null }, ...options]
}
