import type {
  ApiResult,
  AuthStatus,
  ChatClosedEvent,
  ChatEvent,
  ChatEventEnvelope,
  CustosChat,
  PmEvent,
} from './shared/types'

/**
 * The browser implementation of the same `window.custos` surface the
 * Electron preload exposes. Every component talks to that surface and
 * nothing else, so the identical component tree runs in both places with
 * no per-target branching.
 *
 * This is markedly simpler than the Electron side, and for one reason: the
 * page is served by Custos itself, so every request is same-origin. The
 * whole reason the desktop app routes its networking through the main
 * process is that its renderer origin (file:// or localhost:5173) is a
 * different site from the server, so a SameSite=Lax session cookie would
 * never be sent back and CORS would block it anyway. Served from the
 * server's own origin, the cookie just works and fetch is enough.
 */

const sockets = new Map<string, WebSocket>()
let pmSocket: WebSocket | null = null

type Listener<T> = (payload: T) => void
const chatEventListeners = new Set<Listener<ChatEventEnvelope>>()
const chatClosedListeners = new Set<Listener<ChatClosedEvent>>()
const pmEventListeners = new Set<Listener<PmEvent>>()

function wsUrl(path: string, query: Record<string, string>): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      // Same-origin, so the session cookie rides along automatically.
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = (await res.json().catch(() => null)) as T
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: (data as { error?: string } | null)?.error || `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: null as T, error: (err as Error).message }
  }
}

const custos = {
  // The web build is always already pointed at its own server, and the
  // session is whatever the browser is logged in as -- so setup and login
  // are not this surface's job here. A 401 from any call sends the page to
  // /login, which is the same guard the rest of the server uses.
  // Signatures mirror the Electron preload exactly, arguments and all, so
  // the shared components typecheck against one surface. The web build
  // ignores what it doesn't need rather than diverging the API.
  getConfig: async (): Promise<AuthStatus> => ({ baseUrl: window.location.origin, loggedIn: true }),
  setBaseUrl: async (_url: string): Promise<{ ok: boolean }> => ({ ok: true }),
  login: async (_password: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
  logout: async (): Promise<{ ok: boolean }> => {
    window.location.href = '/logout'
    return { ok: true }
  },
  authStatus: async (): Promise<AuthStatus> => ({ baseUrl: window.location.origin, loggedIn: true }),

  api,

  getEmbedUrl: async (): Promise<string | null> => '/admin',
  getAutofillPassword: async (): Promise<string | null> => null,

  openChat: async (chat: CustosChat): Promise<{ ok: boolean; error?: string }> => {
    if (!chat.connectUrl) return { ok: false, error: 'chat has no live connect URL' }
    custos.closeChat(chat.id)
    // Only the token is taken from connectUrl -- its host comes from the
    // server's GATEWAY_PUBLIC_URL, which may be a tunnel hostname that isn't
    // the address this browser actually reached us on.
    const token = new URL(chat.connectUrl, window.location.href).searchParams.get('token') ?? ''
    const socket = new WebSocket(wsUrl('/remote/ws', { token }))

    socket.addEventListener('message', (event) => {
      let parsed: ChatEvent
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      for (const listener of chatEventListeners) listener({ chatId: chat.id, event: parsed })
    })
    socket.addEventListener('close', (event) => {
      sockets.delete(chat.id)
      for (const listener of chatClosedListeners) {
        listener({ chatId: chat.id, reason: event.reason || `closed (${event.code})` })
      }
    })
    socket.addEventListener('error', () => {
      for (const listener of chatClosedListeners) listener({ chatId: chat.id, reason: 'connection error' })
    })

    sockets.set(chat.id, socket)
    return { ok: true }
  },

  sendMessage: (chatId: string, text: string): void => {
    const socket = sockets.get(chatId)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'user_message', text }))
  },

  sendApproval: (chatId: string, id: string, decision: 'allow' | 'deny'): void => {
    const socket = sockets.get(chatId)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'approval_response', id, decision }))
  },

  closeChat: async (chatId: string): Promise<{ ok: boolean }> => {
    sockets.get(chatId)?.close()
    sockets.delete(chatId)
    return { ok: true }
  },

  onChatEvent: (cb: Listener<ChatEventEnvelope>): (() => void) => {
    chatEventListeners.add(cb)
    return () => chatEventListeners.delete(cb)
  },
  onChatClosed: (cb: Listener<ChatClosedEvent>): (() => void) => {
    chatClosedListeners.add(cb)
    return () => chatClosedListeners.delete(cb)
  },

  watchProject: async (projectId: string): Promise<{ ok: boolean }> => {
    pmSocket?.close()
    pmSocket = new WebSocket(wsUrl('/admin/api/pm/ws', { projectId }))
    pmSocket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as PmEvent
        for (const listener of pmEventListeners) listener(parsed)
      } catch {
        // Ignore malformed frames rather than tearing down the subscription.
      }
    })
    return { ok: true }
  },
  unwatchProject: async (): Promise<{ ok: boolean }> => {
    pmSocket?.close()
    pmSocket = null
    return { ok: true }
  },
  onPmEvent: (cb: Listener<PmEvent>): (() => void) => {
    pmEventListeners.add(cb)
    return () => pmEventListeners.delete(cb)
  },
}

declare global {
  interface Window {
    custos: typeof custos
  }
}

window.custos = custos

export {}
