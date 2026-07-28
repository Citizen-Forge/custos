import { useCallback, useEffect, useState } from 'react'
import type { ActivityResponse, AgentDef, CustosProject, ProviderOption } from '@shared/types'
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

  const refresh = useCallback(async () => {
    const [activityRes, agentsRes] = await Promise.all([
      call<ActivityResponse>('GET', `/admin/api/projects/${project.id}/activity`),
      call<{ agents: AgentDef[]; providerOptions: ProviderOption[] }>('GET', `/admin/api/projects/${project.id}/agents`),
    ])
    if (activityRes) setActivity(activityRes)
    if (agentsRes) {
      setAgents(agentsRes.agents)
      setProviderOptions(agentsRes.providerOptions)
    }
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function patchAgent(agent: AgentDef, update: Partial<AgentDef>): Promise<void> {
    await call('PATCH', `/admin/api/agents/${agent.id}`, update)
    refresh()
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
                  value={`${agent.providerKey}::${agent.model}`}
                  onChange={(e) => {
                    const [providerKey, model] = e.target.value.split('::')
                    patchAgent(agent, { providerKey, model })
                  }}
                >
                  {optionsIncluding(providerOptions, agent).map((option) => (
                    <option key={`${option.providerKey}::${option.model}`} value={`${option.providerKey}::${option.model}`}>
                      {option.providerKey} / {option.model}
                      {option.free ? ' (free)' : ''}
                    </option>
                  ))}
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
