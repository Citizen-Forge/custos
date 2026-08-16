import { useCallback, useEffect, useState } from 'react'
import type { AgentDef, WorkItem } from '@shared/types'
import { useCall, relativeTime } from '../api'
import Avatar, { agentLabel } from './Avatar'

interface DetailResponse {
  item: WorkItem
  children: WorkItem[]
  agents: AgentDef[]
}

/**
 * A ticket, everything the agents wrote on it, and the human's own controls.
 * The comment thread is where the whole pipeline becomes legible: the
 * engineer's summary, QA's per-criterion evidence, and the reason a ticket
 * bounced all land here as comments from named agents.
 */
export default function TicketDetail({
  itemId,
  revision,
  onClose,
  onChanged
}: {
  itemId: string
  revision: number
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const call = useCall()
  const [data, setData] = useState<DetailResponse | null>(null)
  const [comment, setComment] = useState('')

  const refresh = useCallback(async () => {
    setData(await call<DetailResponse>('GET', `/admin/api/work-items/${itemId}`))
  }, [call, itemId])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function postComment(): Promise<void> {
    if (!comment.trim()) return
    await call('POST', `/admin/api/work-items/${itemId}/comments`, { body: comment.trim() })
    setComment('')
    await refresh()
    onChanged()
  }

  async function toggleSubtask(subtaskId: string, done: boolean): Promise<void> {
    await call('POST', `/admin/api/work-items/${itemId}/subtasks/${subtaskId}`, { done })
    refresh()
  }

  async function remove(): Promise<void> {
    if (!data) return
    if (!confirm(`Delete "${data.item.title}"?`)) return
    await call('DELETE', `/admin/api/work-items/${itemId}`)
    onClose()
    onChanged()
  }

  async function escalate(): Promise<void> {
    if (!data) return
    const target = data.item.status === 'in_progress' ? 'the Principal Engineer' : 'Principal QA'
    if (!confirm(`Escalate "${data.item.title}" to ${target} now? This uses real, metered Anthropic usage.`)) return
    const res = await call<{ ok: true; escalatedTo: string }>('POST', `/admin/api/work-items/${itemId}/escalate`)
    if (!res) return
    await refresh()
    onChanged()
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        {!data ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <>
            <header className="drawer-header">
              <span className={`type-pill ${data.item.type}`}>{data.item.type}</span>
              <span className={`badge status-${data.item.status}`}>{data.item.status.replace('_', ' ')}</span>
              <span style={{ flex: 1 }} />
              {(data.item.status === 'in_progress' || data.item.status === 'qa') && (
                <button onClick={escalate} title="Hand this ticket to the Principal Engineer / Principal QA now, instead of waiting for repeated failures">
                  Escalate
                </button>
              )}
              <button className="danger" onClick={remove}>
                Delete
              </button>
              <button onClick={onClose}>Close</button>
            </header>

            <div className="drawer-body">
              <h2>{data.item.title}</h2>
              <div className="drawer-meta">
                <span>{data.item.complexity ? `complexity: ${data.item.complexity}` : 'not sized'}</span>
                {data.item.assigneeAgentId && (
                  <span>assigned to {agentLabel(data.agents.find((a) => a.id === data.item.assigneeAgentId)) ?? 'unknown agent'}</span>
                )}
                {data.item.qaAssigneeAgentId && (
                  <span className="warn-text">
                    escalated to {agentLabel(data.agents.find((a) => a.id === data.item.qaAssigneeAgentId)) ?? 'Principal QA'}
                  </span>
                )}
                {data.item.branch && <span>branch {data.item.branch}</span>}
                {data.item.worktreePath && <span>own checkout</span>}
                {data.item.qaRounds > 0 && <span className="warn-text">bounced by QA {data.item.qaRounds}x</span>}
              </div>
              {(data.item.prUrl || data.item.prComments.length > 0) && (
                <section className="pr-activity">
                  <h3>PR Activity</h3>
                  {data.item.prUrl && (
                    <p className="pr-link">
                      <a href={data.item.prUrl} target="_blank" rel="noreferrer">
                        View on GitHub ↗
                      </a>
                    </p>
                  )}
                  {data.item.prComments?.length > 0 && (
                    <div className="pr-comments">
                      {data.item.prComments.map((entry, i) => {
                        // Handle both the new object shape ({text, createdAt})
                        // and legacy plain strings stored before timestamps
                        // were added to the data model.
                        const text = typeof entry === 'string' ? entry : entry.text;
                        const ts = typeof entry === 'string' ? null : entry.createdAt;
                        return (
                          <div className="pr-comment" key={i}>
                            <div className="comment-head">
                              <strong>QA</strong>
                              <span className="muted">{ts ? relativeTime(ts) : '· just now'}</span>
                            </div>
                            <div className="comment-body">{text}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {data.item.description && <div className="prose">{data.item.description}</div>}

              {data.item.acceptanceCriteria.length > 0 && (
                <>
                  <h3>Acceptance criteria</h3>
                  <ul className="criteria">
                    {data.item.acceptanceCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </>
              )}

              {data.item.subtasks.length > 0 && (
                <>
                  <h3>Subtasks</h3>
                  <ul className="subtasks">
                    {data.item.subtasks.map((s) => (
                      <li key={s.id}>
                        <label>
                          <input type="checkbox" checked={s.done} onChange={(e) => toggleSubtask(s.id, e.target.checked)} />
                          <span className={s.done ? 'done' : ''}>{s.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {data.children.length > 0 && (
                <>
                  <h3>Stories</h3>
                  <div className="child-list">
                    {data.children.map((child) => (
                      <div className="child-row" key={child.id}>
                        <span className={`type-pill ${child.type}`}>{child.type}</span>
                        <span className="child-title">{child.title}</span>
                        <span className={`badge status-${child.status}`}>{child.status.replace('_', ' ')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <h3>Activity</h3>
              <div className="thread">
                {data.item.comments.length === 0 && <p className="hint">No comments yet.</p>}
                {data.item.comments.map((c) => (
                  <div className="comment" key={c.id}>
                    <div className="comment-head">
                      <Avatar name={c.authorLabel} size={18} />
                      <strong>{c.authorLabel}</strong>
                      <span className="muted">{relativeTime(c.createdAt)}</span>
                    </div>
                    <div className="comment-body">{c.body}</div>
                  </div>
                ))}
              </div>

              <div className="history">
                {data.item.history.map((h, i) => (
                  <div key={i} className="history-row">
                    {h.from ?? '—'} → {h.to} · {relativeTime(h.at)}
                    {h.note ? ` · ${h.note}` : ''}
                  </div>
                ))}
              </div>
            </div>

            <footer className="drawer-footer">
              <textarea
                rows={2}
                value={comment}
                placeholder="Leave a comment for the agents…"
                onChange={(e) => setComment(e.target.value)}
              />
              <button className="primary" onClick={postComment} disabled={!comment.trim()}>
                Comment
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  )
}
