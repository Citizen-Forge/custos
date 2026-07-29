import { useCallback, useEffect, useState } from 'react'
import type { ActivityResponse, AgentDef, AgentsResponse, CustosProject, FallbackSetOption } from '@shared/types'
import { useCall, relativeTime } from '../api'
import Avatar, { agentLabel } from './Avatar'
import AgentModelSelect, { isOrphaned, parseModelSelectValue } from './AgentModelSelect'

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
  const [fallbackSets, setFallbackSets] = useState<Record<string, FallbackSetOption>>({})

  const refresh = useCallback(async () => {
    const [activityRes, agentsRes] = await Promise.all([
      call<ActivityResponse>('GET', `/admin/api/projects/${project.id}/activity`),
      call<AgentsResponse>('GET', `/admin/api/projects/${project.id}/agents`),
    ])
    if (activityRes) setActivity(activityRes)
    if (agentsRes) {
      setAgents(agentsRes.agents)
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

  /** Flips pmConfigured to false so the PM re-runs on the next tick and
   *  picks a valid fallback set for every agent in the project. Used as
   *  the recovery path for orphaned agents (the dropdown's "[orphaned:
   *  <name>] — Reset PM to recover" hint points here). The endpoint
   *  doesn't immediately re-assign; the orchestrator's existing 20s
   *  tick reads !pmConfigured and triggers assignModels() on its own. */
  async function resetProjectPM(): Promise<void> {
    await call('POST', `/admin/api/projects/${project.id}/reset-pm`)
    refresh()
  }

  /** Adapter from the AgentModelSelect's value-format-onChange back to the
   *  PATCH body. The select emits `set::<name>` (or the empty sentinel
   *  for "no selection"); parseModelSelectValue decodes it into a typed
   *  ModelPatch whose single `kind` is always `fallback` after the
   *  providerKey/model drop. We send `{ fallbackSet: <name> }` and the
   *  runtime derives the dispatch target from `fallbackSet[0]` -- there's
   *  no second field to write, so the patch body is a single property. */
  function onModelChange(agent: AgentDef, value: string): void {
    const patch = parseModelSelectValue(value)
    if (!patch) return
    void patchAgent(agent, { fallbackSet: patch.fallbackSet })
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
              {/* The label wraps only the select so a click on the button
                  doesn't focus the dropdown as a side effect. The button
                  sits outside the label but inside the same row. */}
              <div className="field inline">
                <label>
                  <span>Model</span>
                  <AgentModelSelect
                    agent={agent}
                    fallbackSets={fallbackSets}
                    onChange={(value) => onModelChange(agent, value)}
                  />
                </label>
                <button
                  type="button"
                  className={isOrphaned(agent, fallbackSets) ? 'primary' : ''}
                  onClick={() => void resetProjectPM()}
                  title={
                    isOrphaned(agent, fallbackSets)
                      ? 'Reset the Project Manager so it re-runs and picks a valid fallback set on the next tick (~20s). Flips pmConfigured for the entire project; all roles get re-evaluated, not just this one.'
                      : 'Re-run the Project Manager to re-evaluate fallback-set assignments for every role (flips pmConfigured for the whole project; recovery happens on the next tick, ~20s).'
                  }
                >
                  {isOrphaned(agent, fallbackSets) ? 'Recover' : 'Reset PM'}
                </button>
              </div>
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
