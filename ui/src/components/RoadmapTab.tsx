import { useCallback, useEffect, useState } from 'react'
import type { CustosProject, EpicWithChildren, Idea, RoadmapResponse, WorkItem } from '@shared/types'
import { useCall, relativeTime } from '../api'
import type { PromptRequest } from './PromptModal'

/**
 * The roadmap: an inbox of ideas waiting to be shaped, and the epics the
 * product owner has already broken them into. Stories nest under their
 * epic here rather than showing as loose cards -- the roadmap is the
 * "what are we building" view; the board is the "what is being worked" one.
 */
export default function RoadmapTab({
  project,
  revision,
  onChanged,
  askText
}: {
  project: CustosProject
  revision: number
  onChanged: () => void
  askText: (title: string, opts?: Omit<PromptRequest, 'title'>) => Promise<string | null>
}): React.JSX.Element {
  const call = useCall()
  const [data, setData] = useState<RoadmapResponse | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    setData(await call<RoadmapResponse>('GET', `/admin/api/projects/${project.id}/roadmap`))
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function addIdea(): Promise<void> {
    const title = await askText('Idea title')
    if (!title?.trim()) return
    const brief = await askText('Brief — the problem, the proposed shape, constraints', { placeholder: 'Markdown is fine' })
    if (!brief?.trim()) return
    await call('POST', `/admin/api/projects/${project.id}/ideas`, { title: title.trim(), brief: brief.trim() })
    onChanged()
  }

  async function planIdea(idea: Idea): Promise<void> {
    await call('POST', `/admin/api/ideas/${idea.id}/plan`)
    onChanged()
  }

  async function dropIdea(idea: Idea): Promise<void> {
    if (!confirm(`Drop "${idea.title}" from the inbox?`)) return
    await call('DELETE', `/admin/api/ideas/${idea.id}`)
    onChanged()
  }

  async function groom(): Promise<void> {
    await call('POST', `/admin/api/projects/${project.id}/run/groom`)
    onChanged()
  }

  if (!data) return <div className="empty-state">Loading roadmap…</div>

  const planning = new Set(data.busy.filter((k) => k.startsWith('plan:')).map((k) => k.slice(5)))
  const grooming = data.busy.includes(`groom:${project.id}`)

  return (
    <div className="roadmap">
      <section className="roadmap-inbox">
        <header className="section-header">
          <h2>Inbox</h2>
          <button onClick={addIdea}>Add idea</button>
        </header>
        {data.inbox.length === 0 && <p className="hint">Empty. Ideas land here when Steering Co hands one off.</p>}
        {data.inbox.map((idea) => (
          <article key={idea.id} className={`card idea${idea.status === 'planning' || planning.has(idea.id) ? ' working' : ''}`}>
            <div className="card-title">{idea.title}</div>
            <div className="card-body">{idea.brief}</div>
            {idea.error && <div className="card-error">Last attempt failed: {idea.error}</div>}
            <div className="card-footer">
              <span className="muted">{relativeTime(idea.createdAt)}</span>
              <span style={{ flex: 1 }} />
              {idea.status === 'planning' || planning.has(idea.id) ? (
                <span className="badge working">Product owner is planning this…</span>
              ) : (
                <>
                  <button onClick={() => planIdea(idea)}>Plan it</button>
                  <button className="danger" onClick={() => dropIdea(idea)}>
                    Drop
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="roadmap-backlog">
        <header className="section-header">
          <h2>Backlog</h2>
          <button onClick={groom} disabled={grooming}>
            {grooming ? 'Grooming…' : 'Groom backlog'}
          </button>
        </header>
        {data.epics.length === 0 && <p className="hint">No epics yet. Plan an idea from the inbox to create some.</p>}
        {data.epics.map((entry) => (
          <EpicCard
            key={entry.epic.id}
            entry={entry}
            expanded={expanded[entry.epic.id] ?? true}
            onToggle={() => setExpanded((e) => ({ ...e, [entry.epic.id]: !(e[entry.epic.id] ?? true) }))}
          />
        ))}
      </section>
    </div>
  )
}

function EpicCard({
  entry,
  expanded,
  onToggle
}: {
  entry: EpicWithChildren
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { epic, children, progress } = entry
  return (
    <article className="card epic">
      <div className="card-title" onClick={onToggle}>
        <span className="disclosure">{expanded ? '▾' : '▸'}</span>
        {epic.title}
        <span style={{ flex: 1 }} />
        <span className={`badge status-${epic.status}`}>{epic.status.replace('_', ' ')}</span>
      </div>
      {children.length > 0 && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span className="progress-label">
            {children.filter((c) => c.status === 'complete').length}/{children.length} done
          </span>
        </div>
      )}
      {expanded && (
        <>
          {epic.description && <div className="card-body">{epic.description}</div>}
          {epic.acceptanceCriteria.length > 0 && (
            <ul className="criteria">
              {epic.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <div className="child-list">
            {children.map((child) => (
              <ChildRow key={child.id} item={child} />
            ))}
            {children.length === 0 && <p className="hint">No stories under this epic yet.</p>}
          </div>
        </>
      )}
    </article>
  )
}

function ChildRow({ item }: { item: WorkItem }): React.JSX.Element {
  return (
    <div className="child-row">
      <span className={`type-pill ${item.type}`}>{item.type}</span>
      <span className="child-title">{item.title}</span>
      <span className={`badge status-${item.status}`}>{item.status.replace('_', ' ')}</span>
    </div>
  )
}
