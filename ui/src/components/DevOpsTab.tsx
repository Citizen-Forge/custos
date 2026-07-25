import { useCallback, useEffect, useState } from 'react'
import type { ActivityResponse, AgentDef, CustosProject, DeployTarget, ProjectSettings, ProviderOption } from '@shared/types'
import { useCall, relativeTime } from '../api'
import SecretsPanel from './SecretsPanel'
import KnowledgePanel from './KnowledgePanel'

const AUTONOMY_ROLES: Array<{ key: keyof ProjectSettings['autonomy']; label: string; blurb: string }> = [
  { key: 'product-owner', label: 'Product owner', blurb: 'Plans handed-off ideas into epics and grooms the backlog.' },
  { key: 'engineering-manager', label: 'Engineering manager', blurb: 'Sizes ready tickets, picks or creates an engineer, starts the work.' },
  { key: 'engineer', label: 'Engineers', blurb: 'Implement assigned tickets unattended and open pull requests.' },
  { key: 'qa', label: 'QA', blurb: 'Runs the work in Docker and passes it or bounces it back.' },
  { key: 'devops', label: 'DevOps', blurb: 'Deploys completed work to the configured target and provisions infrastructure.' }
]

const DEPLOY_TARGETS: Array<{ value: DeployTarget; label: string }> = [
  { value: 'none', label: 'None — nothing is deployed' },
  { value: 'docker-local', label: 'Local Docker' },
  { value: 'aws', label: 'AWS' }
]

/**
 * Deployment configuration, the money controls, and the record of what the
 * agents have actually been doing. The autonomy switches live here rather
 * than in global settings because they're a per-project decision: handing
 * an experiment's board to unattended engineers is a very different call
 * from handing it a production repo's.
 */
export default function DevOpsTab({
  project,
  revision,
  onChanged
}: {
  project: CustosProject
  revision: number
  onChanged: () => void
}): React.JSX.Element {
  const call = useCall()
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [spentUsd, setSpentUsd] = useState(0)
  const [subscriptionUsd, setSubscriptionUsd] = useState(0)
  const [activity, setActivity] = useState<ActivityResponse | null>(null)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])

  const refresh = useCallback(async () => {
    const [settingsRes, activityRes, agentsRes] = await Promise.all([
      call<{ settings: ProjectSettings; spentUsd: number; subscriptionUsd: number }>(
        'GET',
        `/admin/api/projects/${project.id}/settings`
      ),
      call<ActivityResponse>('GET', `/admin/api/projects/${project.id}/activity`),
      call<{ agents: AgentDef[]; providerOptions: ProviderOption[] }>('GET', `/admin/api/projects/${project.id}/agents`)
    ])
    if (settingsRes) {
      setSettings(settingsRes.settings)
      setSpentUsd(settingsRes.spentUsd)
      setSubscriptionUsd(settingsRes.subscriptionUsd)
    }
    if (activityRes) setActivity(activityRes)
    if (agentsRes) {
      setAgents(agentsRes.agents)
      setProviderOptions(agentsRes.providerOptions)
    }
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function patch(update: Partial<Omit<ProjectSettings, 'id'>>): Promise<void> {
    const res = await call<{ settings: ProjectSettings }>('PATCH', `/admin/api/projects/${project.id}/settings`, update)
    if (res) setSettings(res.settings)
    onChanged()
  }

  async function patchAgent(agent: AgentDef, update: Partial<AgentDef>): Promise<void> {
    await call('PATCH', `/admin/api/agents/${agent.id}`, update)
    refresh()
  }

  if (!settings) return <div className="empty-state">Loading…</div>

  const budget = settings.budget.monthlyUsd

  return (
    <div className="devops">
      <div className="devops-columns">
        <section className="panel">
          <h2>Project</h2>
          <label className="field">
            <span>Repository URL</span>
            <input
              type="text"
              defaultValue={settings.repoUrl ?? ''}
              placeholder="git@github.com:you/project.git"
              onBlur={(e) => patch({ repoUrl: e.target.value.trim() || null })}
            />
          </label>
          <label className="field">
            <span>Default branch</span>
            <input type="text" defaultValue={settings.defaultBranch} onBlur={(e) => patch({ defaultBranch: e.target.value.trim() || 'main' })} />
          </label>
          <label className="field">
            <span>Steering model</span>
            <input
              type="text"
              defaultValue={settings.steeringModel}
              onBlur={(e) => patch({ steeringModel: e.target.value.trim() })}
            />
            <small>
              A pinned <code>custos:&lt;provider&gt;/&lt;model&gt;</code> alias. Steering Co argues with you — give it a strong model.
            </small>
          </label>
          <label className="field">
            <span>Reference docs (comma separated, relative to the workspace)</span>
            <input
              type="text"
              defaultValue={settings.docsPaths.join(', ')}
              placeholder="docs/spec.md, ARCHITECTURE.md"
              onBlur={(e) => patch({ docsPaths: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </label>
        </section>

        <section className="panel">
          <h2>Deployment</h2>
          <label className="field">
            <span>Target</span>
            <select value={settings.deployTarget} onChange={(e) => patch({ deployTarget: e.target.value as DeployTarget })}>
              {DEPLOY_TARGETS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Target settings (key=value per line)</span>
            <textarea
              rows={4}
              defaultValue={Object.entries(settings.deployConfig).map(([k, v]) => `${k}=${v}`).join('\n')}
              placeholder={'region=eu-west-2\ncomposeFile=docker-compose.yml'}
              onBlur={(e) => patch({ deployConfig: parseKeyValues(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Infrastructure budget (USD/month, blank for none)</span>
            <input
              type="text"
              defaultValue={settings.budget.infraMonthlyUsd ?? ''}
              onBlur={(e) => patch({ budget: { ...settings.budget, infraMonthlyUsd: parseUsd(e.target.value) } })}
            />
          </label>
        </section>

        <section className="panel">
          <h2>Budget & autonomy</h2>
          <label className="field">
            <span>Agent budget (USD/month, blank for none)</span>
            <input
              type="text"
              defaultValue={budget ?? ''}
              onBlur={(e) => patch({ budget: { ...settings.budget, monthlyUsd: parseUsd(e.target.value) } })}
            />
          </label>
          <div className="budget-readout">
            <strong>${spentUsd.toFixed(2)}</strong> metered spend this month{budget !== null ? ` of $${budget.toFixed(2)}` : ''}.
            {budget !== null && spentUsd >= budget && <span className="warn-text"> Agents are paused until next month.</span>}
            {subscriptionUsd > 0 && (
              <div className="muted" style={{ marginTop: 4 }}>
                A further ${subscriptionUsd.toFixed(2)} of work was covered by your Claude subscription and local models — it
                doesn&rsquo;t count against the cap.
              </div>
            )}
          </div>

          <label className="field">
            <span>Max concurrent engineers</span>
            <input
              type="number"
              min={1}
              max={12}
              defaultValue={settings.maxConcurrentEngineers}
              onBlur={(e) => patch({ maxConcurrentEngineers: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
            />
            <small>
              A ceiling, not a target — the engineering manager decides how many to actually run, and each one gets its own git
              worktree. Projects that aren&rsquo;t git repositories are held at one regardless.
            </small>
          </label>

          <p className="hint">
            Autonomy is off by default. With a role off, its work only happens when you press the button for it — which is the
            way to watch what an agent does before you let it loose.
          </p>
          {AUTONOMY_ROLES.map((role) => (
            <label className="toggle" key={role.key}>
              <input
                type="checkbox"
                checked={settings.autonomy[role.key]}
                onChange={(e) => patch({ autonomy: { ...settings.autonomy, [role.key]: e.target.checked } })}
              />
              <div>
                <div className="toggle-label">{role.label}</div>
                <div className="toggle-blurb">{role.blurb}</div>
              </div>
            </label>
          ))}
        </section>
      </div>

      <KnowledgePanel project={project} settings={settings} revision={revision} onChanged={onChanged} />

      <SecretsPanel project={project} revision={revision} />

      <section className="panel">
        <h2>Agents</h2>
        <div className="agent-grid">
          {agents.map((agent) => (
            <article className={`agent-card${agent.active ? '' : ' inactive'}`} key={agent.id}>
              <div className="agent-head">
                <strong>{agent.name}</strong>
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

      <section className="panel">
        <h2>Activity</h2>
        {activity?.active.length ? (
          <div className="running-list">
            {activity.active.map((run) => {
              const stalled = activity.stalledRunIds.includes(run.id)
              return (
                <div key={run.id} className={`running-row${stalled ? ' stalled' : ''}`}>
                  <div className="running-head">
                    <span className={`badge ${stalled ? 'warn' : 'working'}`}>{stalled ? 'no activity' : 'running'}</span>
                    <strong>{run.role}</strong>
                    <span className="muted">
                      {run.providerKey}/{run.model}
                    </span>
                    <span className="muted">started {relativeTime(run.startedAt)}</span>
                    <span className="muted">{run.toolCalls} tool calls</span>
                  </div>
                  <div className="running-action">
                    {run.currentAction ?? 'thinking…'}
                    <span className="muted"> · last moved {relativeTime(run.lastEventAt)}</span>
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

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function parseUsd(value: string): number | null {
  const parsed = Number(value.trim().replace(/^\$/, ''))
  return value.trim() && Number.isFinite(parsed) ? parsed : null
}
