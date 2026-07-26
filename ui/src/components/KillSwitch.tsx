import { useCallback, useEffect, useState } from 'react'
import type { CustosProject, ProjectSettings } from '@shared/types'
import { useCall } from '../api'

/**
 * Stop everything, now. Lives in the project header rather than buried in a
 * settings tab because the moment you want it is the moment you've noticed
 * agents doing something expensive or wrong, and hunting for it costs money.
 *
 * Pausing aborts every running agent for this project rather than waiting
 * for them to finish, and the flag is persisted so nothing quietly resumes
 * on the next restart.
 */
export default function KillSwitch({
  project,
  revision,
  onChanged
}: {
  project: CustosProject
  revision: number
  onChanged: () => void
}): React.JSX.Element | null {
  const call = useCall()
  const [paused, setPaused] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const res = await call<{ settings: ProjectSettings }>('GET', `/admin/api/projects/${project.id}/settings`)
    if (res) setPaused(!!res.settings.paused)
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function toggle(): Promise<void> {
    setBusy(true)
    const res = await call<{ aborted?: number }>('POST', `/admin/api/projects/${project.id}/${paused ? 'resume' : 'pause'}`)
    setBusy(false)
    if (!res) return
    if (!paused && res.aborted) alert(`Paused. ${res.aborted} running agent(s) stopped.`)
    await refresh()
    onChanged()
  }

  if (paused === null) return null

  return (
    <button className={`killswitch${paused ? ' paused' : ''}`} onClick={toggle} disabled={busy} title={paused ? 'Resume this project' : 'Stop all agents on this project immediately'}>
      {busy ? '…' : paused ? '▶ Paused — resume' : '⏸ Stop agents'}
    </button>
  )
}
