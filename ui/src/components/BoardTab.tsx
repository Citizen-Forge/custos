import { useCallback, useEffect, useRef, useState } from 'react'
import { BOARD_STATUSES, type AgentDef, type BoardResponse, type BoardStatus, type CustosProject, type WorkItem } from '@shared/types'
import { useCall } from '../api'
import Avatar, { agentLabel } from './Avatar'
import TicketDetail from './TicketDetail'
import type { PromptRequest } from './PromptModal'

// Visible-window for the post-jump pulse, kept in sync with the CSS
// animation duration. Two literals in different files is a future
// drift hazard; this constant is the single source of truth.
const HIGHLIGHT_DURATION_MS = 3000

const COLUMN_LABELS: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  qa: 'QA',
  complete: 'Complete'
}

/** The stage an agent runs against a ticket sitting in each column, for the
 * per-card "run now" button. Backlog and complete have no per-ticket stage:
 * grooming is a whole-backlog pass (on the roadmap tab) and completed work
 * is only picked up by devops when a deploy target is configured. */
const COLUMN_STAGE: Partial<Record<BoardStatus, { stage: string; label: string }>> = {
  in_progress: { stage: 'engineer', label: 'Run engineer' },
  qa: { stage: 'qa', label: 'Run QA' },
  complete: { stage: 'devops', label: 'Deploy' }
}

export default function BoardTab({
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
  const [data, setData] = useState<BoardResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Visual highlight that fades after ~3s. Drives the `.ticket-highlight`
  // class on the targeted TicketCard so the operator's eye finds the row
  // it just jumped to. Disambiguates from `selected` (which opens the
  // TicketDetail drawer) -- a ticket can be highlighted without being
  // opened, and vice versa.
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dragOver, setDragOver] = useState<BoardStatus | null>(null)

  // Hash listener -- picks up `#board-ticket=<id>` set by TeamTab's
  // click-through on the now-working row. Opens the ticket in the
  // detail drawer AND pulse-highlights the card so the operator sees
  // where the jump landed. project.id is captured in the deps to make
  // the listener reset cleanly when the team tab navigates between
  // projects.
  useEffect(() => {
    function onHash(): void {
      const match = window.location.hash.match(/^#board-ticket=(.+)/)
      if (!match) return
      const id = match[1]
      // Validate the ticket id against the currently loaded board
      // before applying state. A stale hash from a previous project's
      // Team tab -- e.g. user clicks ticket X on Project A, then
      // switches to Project B in the sidebar -- would otherwise fire
      // setSelected(staleId) and trigger TicketDetail to fetch a
      // ticket that doesn't exist in this project (404 + error toast).
      // Silently clear the hash on a miss so the next click can land
      // cleanly without that error surface.
      const ticketExists = data
        ? BOARD_STATUSES.some((s) => data.columns[s].some((item) => item.id === id))
        : false
      if (!ticketExists) {
        // Don't clear here on initial mounts where `data` is still
        // loading -- the listener will re-fire via onHash() invoked
        // once the team tab calls refresh().
        if (data) {
          window.history.replaceState(null, '', window.location.pathname)
        }
        return
      }
      setSelected(id)
      setHighlighted(id)
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setHighlighted(null), HIGHLIGHT_DURATION_MS)
      // Wait one frame so the TicketCard that just got the
      // .ticket-highlight class has rendered before we try to scroll
      // to it -- scrollIntoView against an unmounted element is a no-op.
      requestAnimationFrame(() => {
        document.getElementById(`ticket-${id}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
      })
    }
    window.addEventListener('hashchange', onHash)
    onHash()
    return () => {
      window.removeEventListener('hashchange', onHash)
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
    }
  }, [project.id, data])

  const refresh = useCallback(async () => {
    setData(await call<BoardResponse>('GET', `/admin/api/projects/${project.id}/board`))
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function move(itemId: string, status: BoardStatus): Promise<void> {
    await call('POST', `/admin/api/work-items/${itemId}/status`, { status })
    onChanged()
  }

  async function runStage(stage: string, workItemId?: string): Promise<void> {
    await call('POST', `/admin/api/projects/${project.id}/run/${stage}`, workItemId ? { workItemId } : undefined)
    onChanged()
  }

  async function newTicket(): Promise<void> {
    const title = await askText('Ticket title')
    if (!title?.trim()) return
    await call('POST', `/admin/api/projects/${project.id}/work-items`, { type: 'story', title: title.trim() })
    onChanged()
  }

  if (!data) return <div className="empty-state">Loading board…</div>

  const agentsById = new Map(data.agents.map((a) => [a.id, a]))
  const busy = new Set(data.busy)
  const assigning = busy.has(`assign:${project.id}`)

  return (
    <div className="board-tab">
      <header className="section-header">
        <h2>Board</h2>
        <button onClick={newTicket}>New ticket</button>
        <button onClick={() => runStage('assign')} disabled={assigning}>
          {assigning ? 'Assigning…' : 'Assign ready tickets'}
        </button>
      </header>

      <div className="board">
        {BOARD_STATUSES.map((status) => (
          <div
            key={status}
            className={`board-column${dragOver === status ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(status)
            }}
            onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(null)
              const id = e.dataTransfer.getData('text/plain')
              if (id) move(id, status)
            }}
          >
            <div className="board-column-header">
              {COLUMN_LABELS[status]}
              <span className="count">{data.columns[status].length}</span>
            </div>
            <div className="board-column-body">
              {data.columns[status].map((item) => (
                <TicketCard
                  key={item.id}
                  item={item}
                  agent={item.assigneeAgentId ? agentsById.get(item.assigneeAgentId) : undefined}
                  working={busy.has(`engineer:${item.id}`) || busy.has(`qa:${item.id}`) || busy.has(`devops:${item.id}`)}
                  stage={COLUMN_STAGE[status]}
                  highlighted={highlighted === item.id}
                  onOpen={() => setSelected(item.id)}
                  onRun={(stage) => runStage(stage, item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <TicketDetail
          itemId={selected}
          revision={revision}
          onClose={() => setSelected(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function TicketCard({
  item,
  agent,
  working,
  stage,
  highlighted,
  onOpen,
  onRun
}: {
  item: WorkItem
  agent: AgentDef | undefined
  working: boolean
  stage: { stage: string; label: string } | undefined
  highlighted: boolean
  onOpen: () => void
  onRun: (stage: string) => void
}): React.JSX.Element {
  const doneSubtasks = item.subtasks.filter((s) => s.done).length
  return (
    <article
      id={`ticket-${item.id}`}
      className={`ticket${working ? ' working' : ''}${highlighted ? ' ticket-highlight' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
      onClick={onOpen}
    >
      <div className="ticket-head">
        <span className={`type-pill ${item.type}`}>{item.type}</span>
        {item.complexity && <span className={`badge complexity-${item.complexity}`}>{item.complexity}</span>}
        {item.qaRounds > 0 && <span className="badge warn">bounced {item.qaRounds}x</span>}
      </div>
      <div className="ticket-title">{item.title}</div>
      {item.branch && <div className="ticket-branch">{item.branch}</div>}
      {item.subtasks.length > 0 && (
        <div className="ticket-sub">
          {doneSubtasks}/{item.subtasks.length} subtasks
        </div>
      )}
      {item.attempts > 0 && item.nextAttemptAt !== null && item.nextAttemptAt > Date.now() && (
        <div className="ticket-sub warn-text">
          {item.attempts} failed {item.attempts === 1 ? 'attempt' : 'attempts'} — retrying shortly
        </div>
      )}
      <div className="ticket-foot">
        {agent ? (
          <span className="assignee">
            <Avatar name={agentLabel(agent)} size={18} title={`${agentLabel(agent)} — ${agent.name}`} />
            {agentLabel(agent)}
          </span>
        ) : (
          <span className="muted">unassigned</span>
        )}
        <span style={{ flex: 1 }} />
        {working ? (
          <span className="badge working">running…</span>
        ) : (
          stage && (
            <button
              className="icon"
              title={stage.label}
              onClick={(e) => {
                e.stopPropagation()
                onRun(stage.stage)
              }}
            >
              ▶
            </button>
          )
        )}
      </div>
    </article>
  )
}
