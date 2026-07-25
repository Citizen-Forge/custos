import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatEvent, CustosChat, MessageContentBlock } from '@shared/types'

type Status = 'connecting' | 'idle' | 'thinking' | 'closed'

interface UserBubble {
  kind: 'user'
  id: string
  text: string
}
interface AssistantBubble {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
}
interface ToolBubble {
  kind: 'tool'
  id: string
  toolUseId: string
  name: string
  input: unknown
  result: string | null
  isError: boolean
}
interface ErrorBubble {
  kind: 'error'
  id: string
  text: string
}
interface ApprovalBubble {
  kind: 'approval'
  id: string
  approvalId: string
  toolName: string
  toolInput: unknown
  reason: string
  severity: 'ask' | 'deny'
  resolved: 'allow' | 'deny' | null
}
interface HandoffBubble {
  kind: 'handoff'
  id: string
  ideaId: string
  title: string
}
type Bubble = UserBubble | AssistantBubble | ToolBubble | ErrorBubble | ApprovalBubble | HandoffBubble

/** The Steering agent's handoff block is machinery, not conversation --
 * the transcript shows the confirmation card the server sends back instead
 * of a wall of raw JSON the user has no use for. */
const HANDOFF_FENCE = /```custos-handoff[ \t]*\r?\n[\s\S]*?```/g

let bubbleSeq = 0
const nextId = (): string => `b${++bubbleSeq}`

export default function ChatView({
  chat,
  initialMessage,
  onStop,
  onDelete,
  onHandoff
}: {
  chat: CustosChat
  initialMessage?: string
  onStop: () => void
  onDelete: () => void
  /** Fired when a Steering Co turn dropped an idea into the roadmap inbox,
   * so the surrounding view can refresh without polling. */
  onHandoff?: () => void
}): React.JSX.Element {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [status, setStatus] = useState<Status>('connecting')
  const [closedReason, setClosedReason] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // The in-progress assistant bubble being built from text_delta events.
  const streamingIdRef = useRef<string | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [bubbles])

  useEffect(() => {
    const handle = (event: ChatEvent): void => {
      switch (event.type) {
        case 'connected':
          setStatus(event.running ? 'thinking' : 'idle')
          break
        case 'text_delta':
          setBubbles((prev) => {
            const streamId = streamingIdRef.current
            if (streamId) {
              return prev.map((b) => (b.id === streamId && b.kind === 'assistant' ? { ...b, text: b.text + event.text } : b))
            }
            const id = nextId()
            streamingIdRef.current = id
            return [...prev, { kind: 'assistant', id, text: event.text, streaming: true }]
          })
          break
        case 'message_final':
          // Authoritative final content -- drop the streamed placeholder and
          // render the real blocks (text + any tool_use, in order).
          setBubbles((prev) => {
            const streamId = streamingIdRef.current
            const withoutStream = streamId ? prev.filter((b) => b.id !== streamId) : prev
            streamingIdRef.current = null
            const additions = blocksToBubbles(event.content)
            return [...withoutStream, ...additions]
          })
          break
        case 'tool_result':
          setBubbles((prev) =>
            prev.map((b) =>
              b.kind === 'tool' && b.toolUseId === event.toolUseId ? { ...b, result: event.content, isError: event.isError } : b
            )
          )
          break
        case 'turn_complete':
          streamingIdRef.current = null
          setStatus('idle')
          if (event.isError && event.resultText) {
            setBubbles((prev) => [...prev, { kind: 'error', id: nextId(), text: event.resultText }])
          }
          break
        case 'approval_request':
          setBubbles((prev) => [
            ...prev,
            {
              kind: 'approval',
              id: nextId(),
              approvalId: event.id,
              toolName: event.toolName,
              toolInput: event.toolInput,
              reason: event.reason,
              severity: event.severity,
              resolved: null
            }
          ])
          break
        case 'approval_resolved':
          setBubbles((prev) =>
            prev.map((b) => (b.kind === 'approval' && b.approvalId === event.id ? { ...b, resolved: event.decision } : b))
          )
          break
        case 'idea_handoff':
          setBubbles((prev) => [...prev, { kind: 'handoff', id: nextId(), ideaId: event.ideaId, title: event.title }])
          onHandoff?.()
          break
        case 'error':
          streamingIdRef.current = null
          setStatus('idle')
          setBubbles((prev) => [...prev, { kind: 'error', id: nextId(), text: event.message }])
          break
      }
    }

    const unsubEvent = window.custos.onChatEvent(({ chatId, event }) => {
      if (chatId === chat.id) handle(event)
    })
    const unsubClosed = window.custos.onChatClosed((event) => {
      if (event.chatId === chat.id) {
        setStatus('closed')
        setClosedReason(event.reason)
      }
    })

    window.custos.openChat(chat).then((res) => {
      if (!res.ok) {
        setStatus('closed')
        setClosedReason(res.error || 'failed to open session')
        return
      }
      if (initialMessage) submit(initialMessage)
    })

    return () => {
      unsubEvent()
      unsubClosed()
      window.custos.closeChat(chat.id)
    }
    // Only re-run per chat id -- see the same reasoning in the old terminal
    // component: parent re-renders (sidebar refreshes) must not tear down a
    // live connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  function submit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || status === 'thinking' || status === 'closed') return
    setBubbles((prev) => [...prev, { kind: 'user', id: nextId(), text: trimmed }])
    window.custos.sendMessage(chat.id, trimmed)
    setStatus('thinking')
    setDraft('')
  }

  function handleFormSubmit(e: FormEvent): void {
    e.preventDefault()
    submit(draft)
  }

  function answerApproval(approvalId: string, decision: 'allow' | 'deny'): void {
    window.custos.sendApproval(chat.id, approvalId, decision)
    // Optimistically mark resolved; the server's approval_resolved echo
    // confirms it (and would resolve it for any other connected viewer too).
    setBubbles((prev) => prev.map((b) => (b.kind === 'approval' && b.approvalId === approvalId ? { ...b, resolved: decision } : b)))
  }

  return (
    <>
      <div className="chat-status-bar">
        <span>
          {status === 'connecting' && 'Connecting…'}
          {status === 'idle' && 'Ready'}
          {status === 'thinking' && 'Claude is working…'}
          {status === 'closed' && `Disconnected${closedReason ? ` -- ${closedReason}` : ''}`}
        </span>
        <span style={{ flex: 1 }} />
        {status === 'thinking' && (
          <button className="danger" onClick={onStop}>
            Stop
          </button>
        )}
        {status === 'closed' && (
          <button className="danger" onClick={onDelete}>
            Delete chat
          </button>
        )}
      </div>

      <div className="transcript" ref={scrollRef}>
        {bubbles.length === 0 && status === 'idle' && <div className="chat-empty">Send a message to start.</div>}
        {bubbles.map((b) => (
          <TranscriptEntry key={b.id} bubble={b} onAnswer={answerApproval} />
        ))}
      </div>

      <form className="chat-composer" onSubmit={handleFormSubmit}>
        <textarea
          value={draft}
          placeholder="Message Claude…"
          rows={1}
          disabled={status === 'closed'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(draft)
            }
          }}
        />
        <button type="submit" className="primary" disabled={status === 'thinking' || status === 'closed' || !draft.trim()}>
          Send
        </button>
      </form>
    </>
  )
}

function blocksToBubbles(content: MessageContentBlock[]): Bubble[] {
  const out: Bubble[] = []
  for (const block of content) {
    if (block.type === 'text') {
      const text = block.text.replace(HANDOFF_FENCE, '').trim()
      if (text) out.push({ kind: 'assistant', id: nextId(), text, streaming: false })
    } else if (block.type === 'tool_use') {
      out.push({ kind: 'tool', id: nextId(), toolUseId: block.id, name: block.name, input: block.input, result: null, isError: false })
    }
  }
  return out
}

function TranscriptEntry({
  bubble,
  onAnswer
}: {
  bubble: Bubble
  onAnswer: (approvalId: string, decision: 'allow' | 'deny') => void
}): React.JSX.Element {
  if (bubble.kind === 'approval') return <ApprovalEntry bubble={bubble} onAnswer={onAnswer} />
  if (bubble.kind === 'handoff') {
    return (
      <div className="entry handoff">
        <div className="entry-label">Handed off to the roadmap</div>
        <div className="entry-body">
          <strong>{bubble.title}</strong> is in the Product Roadmap inbox. The product owner will break it into epics.
        </div>
      </div>
    )
  }
  if (bubble.kind === 'user') {
    return (
      <div className="entry user">
        <div className="entry-label">You</div>
        <div className="entry-body">{bubble.text}</div>
      </div>
    )
  }
  if (bubble.kind === 'assistant') {
    return (
      <div className="entry assistant">
        <div className="entry-label">Claude</div>
        <div className="entry-body">{bubble.text}</div>
      </div>
    )
  }
  if (bubble.kind === 'error') {
    return (
      <div className="entry error">
        <div className="entry-label">Error</div>
        <div className="entry-body">{bubble.text}</div>
      </div>
    )
  }
  return <ToolEntry bubble={bubble} />
}

function ApprovalEntry({
  bubble,
  onAnswer
}: {
  bubble: ApprovalBubble
  onAnswer: (approvalId: string, decision: 'allow' | 'deny') => void
}): React.JSX.Element {
  const argStr = useMemo(() => summarizeToolInput(bubble.toolName, bubble.toolInput), [bubble.toolName, bubble.toolInput])
  const label = bubble.severity === 'deny' ? 'Flagged unsafe — override?' : 'Approval needed'
  return (
    <div className={`entry approval ${bubble.severity}`}>
      <div className="entry-label">{label}</div>
      <div className="approval-head">
        <span className="tool-name">{bubble.toolName}</span>
        <span className="tool-arg">{argStr}</span>
      </div>
      <div className="approval-reason">{bubble.reason}</div>
      {bubble.resolved === null ? (
        <div className="approval-actions">
          <button className="primary" onClick={() => onAnswer(bubble.approvalId, 'allow')}>
            {bubble.severity === 'deny' ? 'Override & run' : 'Approve'}
          </button>
          <button className="danger" onClick={() => onAnswer(bubble.approvalId, 'deny')}>
            Deny
          </button>
        </div>
      ) : (
        <div className={`approval-verdict ${bubble.resolved}`}>{bubble.resolved === 'allow' ? 'Approved' : 'Denied'}</div>
      )}
    </div>
  )
}

function ToolEntry({ bubble }: { bubble: ToolBubble }): React.JSX.Element {
  const inputStr = useMemo(() => summarizeToolInput(bubble.name, bubble.input), [bubble.name, bubble.input])
  return (
    <div className={`entry tool${bubble.isError ? ' error' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">{bubble.name}</span>
        <span className="tool-arg">{inputStr}</span>
      </div>
      {bubble.result !== null && <pre className="tool-output">{bubble.result}</pre>}
    </div>
  )
}

/** A short one-line summary of a tool call's most salient argument, VS-Code
 * style (the command for Bash, the path for file tools), falling back to
 * compact JSON. Keeps the transcript scannable instead of dumping the whole
 * input object inline for every call. */
function summarizeToolInput(_name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const primary = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url ?? obj.prompt
    if (typeof primary === 'string') return primary
  }
  const json = JSON.stringify(input)
  return json && json !== '{}' ? json : ''
}
