import { createContext, useContext } from 'react'

/** Signature every tab uses to talk to Custos. Provided once by Shell so
 * that a 401 anywhere in the tree drops back to the login screen in one
 * place, rather than each view inventing its own expiry handling. */
export type Call = <T,>(method: string, path: string, body?: unknown) => Promise<T | null>

export const ApiContext = createContext<Call | null>(null)

export function useCall(): Call {
  const call = useContext(ApiContext)
  if (!call) throw new Error('useCall must be used inside an ApiContext provider')
  return call
}

export function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
