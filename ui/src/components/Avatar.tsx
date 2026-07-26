import type { AgentDef } from '@shared/types'

/**
 * Initials on a stable colour, generated from the name — not a fetched
 * image. A published page that reaches out to an avatar service for every
 * agent would leak the roster to a third party and break offline, and the
 * point here is only to make one agent distinguishable from another at a
 * glance on a crowded board.
 */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash)
}

export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

/** The name to show for an agent: the human one when it has it. */
export function agentLabel(agent: Pick<AgentDef, 'name' | 'personaName'> | undefined): string {
  if (!agent) return 'unassigned'
  return agent.personaName || agent.name
}

export default function Avatar({
  name,
  size = 22,
  title
}: {
  name: string
  size?: number
  title?: string
}): React.JSX.Element {
  const hue = hashString(name) % 360
  return (
    <span
      className="avatar"
      title={title ?? name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `hsl(${hue} 45% 32%)`,
        color: `hsl(${hue} 70% 88%)`
      }}
    >
      {initialsOf(name)}
    </span>
  )
}
