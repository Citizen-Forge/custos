import { useCallback, useEffect, useState } from 'react'
import type { CustosChat, CustosProject } from '@shared/types'
import { useCall, relativeTime } from '../api'
import ChatView from './ChatView'
import type { PromptRequest } from './PromptModal'

/**
 * The ideation surface. Each discussion is an ordinary Custos chat flagged
 * as `steering`, which the gateway runs on the project's strongest model
 * with the adversarial persona attached. Nothing here writes to the board
 * directly -- the only way out is the agent emitting a handoff, which lands
 * in the roadmap inbox.
 */
export default function SteeringTab({
  project,
  askText,
  revision,
  onChanged
}: {
  project: CustosProject
  askText: (title: string, opts?: Omit<PromptRequest, 'title'>) => Promise<string | null>
  revision: number
  onChanged: () => void
}): React.JSX.Element {
  const call = useCall()
  const [chats, setChats] = useState<CustosChat[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Every chat, not just steering ones. Chats created before the four-tab
  // redesign have kind "chat" and had no surface left to live on, which
  // made them look deleted -- they were only ever hidden.
  const refresh = useCallback(async () => {
    const res = await call<{ chats: CustosChat[] }>('GET', `/admin/api/projects/${project.id}/chats`)
    setChats(res?.chats ?? [])
    setLoading(false)
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function newDiscussion(): Promise<void> {
    const title = await askText('What do you want to think through?', { placeholder: 'New discussion' })
    if (title === null) return
    const res = await call<{ chat: CustosChat }>('POST', `/admin/api/projects/${project.id}/chats`, {
      title: title.trim() || undefined,
      kind: 'steering'
    })
    if (!res) return
    await refresh()
    setActiveId(res.chat.id)
    onChanged()
  }

  async function open(chat: CustosChat): Promise<void> {
    if (!chat.active) {
      const ok = await call('POST', `/admin/api/chats/${chat.id}/reopen`)
      if (!ok) return
      await refresh()
    }
    setActiveId(chat.id)
  }

  async function remove(chat: CustosChat): Promise<void> {
    if (!confirm(`Delete discussion "${chat.title}"? The transcript goes with it.`)) return
    if (activeId === chat.id) setActiveId(null)
    await call('DELETE', `/admin/api/chats/${chat.id}`)
    refresh()
  }

  const active = chats.find((c) => c.id === activeId && c.active)
  const steering = chats.filter((chat) => (chat.kind ?? 'chat') === 'steering')
  const legacy = chats.filter((chat) => (chat.kind ?? 'chat') !== 'steering')

  return (
    <div className="split-pane">
      <div className="split-list">
        <div className="split-list-header">
          <span>Discussions</span>
          <button className="icon" onClick={newDiscussion} title="New discussion">
            +
          </button>
        </div>
        {loading && <p className="empty-state">Loading…</p>}
        {!loading && steering.length === 0 && legacy.length === 0 && (
          <p className="hint">
            Nothing yet. Start a discussion and argue an idea out — the agent will push back, research what it can, and only hand
            something to the roadmap once it holds up.
          </p>
        )}
        {steering.map((chat) => (
          <ChatRow key={chat.id} chat={chat} selected={activeId === chat.id} onOpen={() => open(chat)} onDelete={() => remove(chat)} />
        ))}

        {legacy.length > 0 && (
          <>
            <div className="split-list-header legacy-header">Older chats</div>
            {legacy.map((chat) => (
              <ChatRow key={chat.id} chat={chat} selected={activeId === chat.id} onOpen={() => open(chat)} onDelete={() => remove(chat)} />
            ))}
          </>
        )}
      </div>

      <div className="split-body">
        {/* Every opened discussion stays mounted so switching between two
            of them doesn't drop either transcript or its socket. */}
        {chats
          .filter((chat) => chat.active)
          .map((chat) => (
            <div key={chat.id} className={`split-body-pane${activeId === chat.id ? ' visible' : ''}`}>
              <ChatView
                chat={chat}
                onStop={() => call('POST', `/admin/api/chats/${chat.id}/stop`).then(refresh)}
                onDelete={() => remove(chat)}
                onHandoff={onChanged}
              />
            </div>
          ))}
        {!active && <div className="empty-state">Pick a discussion, or start a new one.</div>}
      </div>
    </div>
  )
}

function ChatRow({
  chat,
  selected,
  onOpen,
  onDelete
}: {
  chat: CustosChat
  selected: boolean
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className={`list-row${selected ? ' selected' : ''}`} onClick={onOpen}>
      <span className={`chat-dot${chat.active ? ' active' : ''}`} />
      <div className="list-row-main">
        <div className="list-row-title">{chat.title}</div>
        <div className="list-row-sub">{relativeTime(chat.createdAt)}</div>
      </div>
      <button
        className="icon danger"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ×
      </button>
    </div>
  )
}
