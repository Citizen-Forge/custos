import { useCallback, useEffect, useState } from 'react'
import type { CustosProject, FactCategory, ProjectFact, ProjectSettings } from '@shared/types'
import { useCall, relativeTime } from '../api'

const CATEGORIES: FactCategory[] = ['repo', 'environment', 'convention', 'docs', 'decision', 'contact']

/**
 * The project's shared knowledge — the store every agent reads at the top of
 * every run and any of them can write to. It's how DevOps tells the
 * engineers where the repository it just created lives, and how QA's
 * discovery that the suite needs a particular command survives past its own
 * run instead of being rediscovered ticket after ticket.
 */
export default function KnowledgePanel({
  project,
  settings,
  revision,
  onChanged
}: {
  project: CustosProject
  settings: ProjectSettings
  revision: number
  onChanged: () => void
}): React.JSX.Element {
  const call = useCall()
  const [facts, setFacts] = useState<ProjectFact[]>([])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<{ key: string; value: string; category: FactCategory }>({
    key: '',
    value: '',
    category: 'decision'
  })

  const refresh = useCallback(async () => {
    const res = await call<{ facts: ProjectFact[] }>('GET', `/admin/api/projects/${project.id}/facts`)
    setFacts(res?.facts ?? [])
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function save(): Promise<void> {
    if (!draft.key.trim() || !draft.value.trim()) return
    await call('POST', `/admin/api/projects/${project.id}/facts`, draft)
    setDraft({ key: '', value: '', category: 'decision' })
    setAdding(false)
    refresh()
  }

  async function remove(fact: ProjectFact): Promise<void> {
    if (!confirm(`Delete "${fact.key}"? Agents will stop being told this.`)) return
    await call('DELETE', `/admin/api/facts/${fact.id}`)
    refresh()
  }

  async function provision(): Promise<void> {
    await call('POST', `/admin/api/projects/${project.id}/run/provision`)
    onChanged()
  }

  const grouped = CATEGORIES.map((category) => ({ category, rows: facts.filter((f) => f.category === category) })).filter(
    (g) => g.rows.length > 0
  )

  return (
    <section className="panel">
      <h2>Project knowledge</h2>
      <p className="hint">
        Shared context every agent gets at the start of every run. Agents write to it themselves as they learn things — where
        the repo is, how to run the tests, a convention they had to work out — so the next one doesn&rsquo;t have to rediscover it.
      </p>

      {!settings.repoUrl && (
        <div className="callout">
          <strong>No repository yet.</strong> Engineers have nowhere to branch and QA has nothing to check out. DevOps can create
          one, push a first commit and record the URL here — it needs a GitHub token in the vault marked <em>use for git</em>.
          <div style={{ marginTop: 10 }}>
            <button onClick={provision}>Create the repository</button>
          </div>
        </div>
      )}

      {grouped.length === 0 && <p className="hint">Nothing recorded yet.</p>}
      {grouped.map((group) => (
        <div className="fact-group" key={group.category}>
          <div className="fact-category">{group.category}</div>
          {group.rows.map((fact) => (
            <div className="fact-row" key={fact.id}>
              <code className="fact-key">{fact.key}</code>
              <span className="fact-value">{fact.value}</span>
              <span className="fact-author">{fact.writtenByLabel}</span>
              <span className="fact-age">{relativeTime(fact.updatedAt)}</span>
              <button className="icon danger" title="Delete" onClick={() => remove(fact)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ))}

      {adding ? (
        <div className="secret-form">
          <label className="field">
            <span>Key</span>
            <input
              type="text"
              placeholder="test.command"
              value={draft.key}
              onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>Value</span>
            <input
              type="text"
              placeholder="pnpm test:ci"
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>Category</span>
            <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as FactCategory }))}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button onClick={() => setAdding(false)}>Cancel</button>
            <button className="primary" onClick={save} disabled={!draft.key.trim() || !draft.value.trim()}>
              Record
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}>Record something</button>
      )}
    </section>
  )
}
