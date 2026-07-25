import { useCallback, useEffect, useRef, useState } from 'react'
import type { CustosProject } from '@shared/types'
import SteeringTab from './SteeringTab'
import RoadmapTab from './RoadmapTab'
import BoardTab from './BoardTab'
import DevOpsTab from './DevOpsTab'
import type { PromptRequest } from './PromptModal'

const TABS = [
  { id: 'steering', label: 'Steering Co' },
  { id: 'roadmap', label: 'Product Roadmap' },
  { id: 'board', label: 'Board' },
  { id: 'devops', label: 'DevOps' }
] as const

export type ProjectTabId = (typeof TABS)[number]['id']

export interface ProjectViewProps {
  project: CustosProject
  askText: (title: string, opts?: Omit<PromptRequest, 'title'>) => Promise<string | null>
}

/**
 * One project's four tabs, and the single place that subscribes to the
 * project's change stream. Tabs don't each open their own socket -- they
 * take a `revision` number that bumps on every push, and refetch when it
 * changes. Agent runs touch several stores at once, so "something moved,
 * go and look" is both simpler and more accurate than pushing diffs.
 */
export default function ProjectView({ project, askText }: ProjectViewProps): React.JSX.Element {
  const [tab, setTab] = useState<ProjectTabId>('steering')
  const [revision, setRevision] = useState(0)
  const [toast, setToast] = useState<{ message: string; at: number } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.custos.watchProject(project.id)
    const off = window.custos.onPmEvent((event) => {
      if (event.projectId !== project.id) return
      if (event.type === 'pm_change') setRevision((r) => r + 1)
      if (event.type === 'pm_activity') {
        setRevision((r) => r + 1)
        setToast({ message: event.message, at: event.at })
      }
    })
    return () => {
      off()
      window.custos.unwatchProject()
    }
  }, [project.id])

  useEffect(() => {
    if (!toast) return
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 9000)
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [toast])

  const bump = useCallback(() => setRevision((r) => r + 1), [])

  return (
    <div className="project-view">
      <div className="project-tabs">
        <div className="project-title">{project.name}</div>
        {TABS.map((t) => (
          <button key={t.id} className={`project-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="project-tab-body">
        {/* Steering stays mounted across tab switches: it owns live chat
            websockets, and remounting it would drop the transcript the user
            is mid-conversation in. The other three refetch cheaply. */}
        <div className={`project-pane${tab === 'steering' ? ' visible' : ''}`}>
          <SteeringTab project={project} askText={askText} revision={revision} onChanged={bump} />
        </div>
        {tab === 'roadmap' && (
          <div className="project-pane visible">
            <RoadmapTab project={project} revision={revision} onChanged={bump} askText={askText} />
          </div>
        )}
        {tab === 'board' && (
          <div className="project-pane visible">
            <BoardTab project={project} revision={revision} onChanged={bump} askText={askText} />
          </div>
        )}
        {tab === 'devops' && (
          <div className="project-pane visible">
            <DevOpsTab project={project} revision={revision} onChanged={bump} />
          </div>
        )}
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
    </div>
  )
}
