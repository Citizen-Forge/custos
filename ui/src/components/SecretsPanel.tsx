import { useCallback, useEffect, useState } from 'react'
import type { CustosProject, SecretSummary } from '@shared/types'
import { useCall, relativeTime } from '../api'

/**
 * The vault, as much of it as can be shown. Values are write-only by
 * design — nothing in this UI can read a stored secret back, because
 * nothing in the API can either. A secret you've lost is replaced, not
 * recovered.
 */
export default function SecretsPanel({ project, revision }: { project: CustosProject; revision: number }): React.JSX.Element {
  const call = useCall()
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [adding, setAdding] = useState(false)
  const [replacing, setReplacing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await call<{ secrets: SecretSummary[] }>('GET', `/admin/api/projects/${project.id}/secrets`)
    setSecrets(res?.secrets ?? [])
  }, [call, project.id])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  async function remove(secret: SecretSummary): Promise<void> {
    if (!confirm(`Delete ${secret.name}? Agents relying on it will start failing.`)) return
    await call('DELETE', `/admin/api/secrets/${secret.id}`)
    refresh()
  }

  async function toggle(secret: SecretSummary, patch: Partial<SecretSummary>): Promise<void> {
    await call('PATCH', `/admin/api/secrets/${secret.id}`, patch)
    refresh()
  }

  return (
    <section className="panel">
      <h2>Secrets</h2>
      <p className="hint">
        Encrypted at rest and injected into agent runs as environment variables. Values can never be read back — not by this app,
        not by the API. Agent output is scanned and any secret found in it is redacted before it reaches a ticket or the run log.
      </p>

      <div className="secret-list">
        {secrets.length === 0 && <p className="hint">Nothing stored yet.</p>}
        {secrets.map((secret) => (
          <article className="secret-row" key={secret.id}>
            <div className="secret-head">
              <code className="secret-name">{secret.name}</code>
              <span className="secret-hint">…{secret.hint}</span>
              <span className="badge">{secret.projectId ? 'this project' : 'all projects'}</span>
              {secret.useForGit && <span className="badge">git + gh</span>}
              {!secret.exposeToAgents && <span className="badge warn">hidden from agents</span>}
              <span style={{ flex: 1 }} />
              <button className="icon" title="Replace value" onClick={() => setReplacing(secret.id)}>
                ↻
              </button>
              <button className="icon danger" title="Delete" onClick={() => remove(secret)}>
                ×
              </button>
            </div>
            {secret.description && <div className="secret-desc">{secret.description}</div>}
            <div className="secret-meta">
              added {relativeTime(secret.createdAt)}
              {secret.lastUsedAt ? ` · last used ${relativeTime(secret.lastUsedAt)}` : ' · never used'}
            </div>
            <div className="secret-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={secret.exposeToAgents}
                  onChange={(e) => toggle(secret, { exposeToAgents: e.target.checked })}
                />
                Available to agents
              </label>
              <label>
                <input type="checkbox" checked={secret.useForGit} onChange={(e) => toggle(secret, { useForGit: e.target.checked })} />
                Use for git &amp; GitHub CLI
              </label>
            </div>
            {replacing === secret.id && (
              <SecretForm
                mode="replace"
                onCancel={() => setReplacing(null)}
                onSubmit={async (values) => {
                  await call('PATCH', `/admin/api/secrets/${secret.id}`, { value: values.value })
                  setReplacing(null)
                  refresh()
                }}
              />
            )}
          </article>
        ))}
      </div>

      {adding ? (
        <SecretForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            const res = await call('POST', '/admin/api/secrets', {
              ...values,
              projectId: values.global ? null : project.id
            })
            if (res) {
              setAdding(false)
              refresh()
            }
          }}
        />
      ) : (
        <button onClick={() => setAdding(true)}>Add a secret</button>
      )}
    </section>
  )
}

interface SecretFormValues {
  name: string
  value: string
  description: string
  global: boolean
  exposeToAgents: boolean
  useForGit: boolean
}

function SecretForm({
  mode,
  onSubmit,
  onCancel
}: {
  mode: 'create' | 'replace'
  onSubmit: (values: SecretFormValues) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<SecretFormValues>({
    name: '',
    value: '',
    description: '',
    global: true,
    exposeToAgents: true,
    useForGit: false
  })
  const set = <K extends keyof SecretFormValues,>(key: K, v: SecretFormValues[K]): void =>
    setValues((prev) => ({ ...prev, [key]: v }))

  return (
    <div className="secret-form">
      {mode === 'create' && (
        <>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              placeholder="GITHUB_TOKEN"
              value={values.name}
              onChange={(e) => set('name', e.target.value.toUpperCase())}
            />
            <small>Becomes an environment variable of this name, so: capitals, digits and underscores.</small>
          </label>
          <label className="field">
            <span>What it&rsquo;s for</span>
            <input type="text" placeholder="Pushing branches and opening PRs" value={values.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span>Value</span>
        <input type="password" autoComplete="off" value={values.value} onChange={(e) => set('value', e.target.value)} />
        <small>Stored encrypted. You will not be able to read it back.</small>
      </label>
      {mode === 'create' && (
        <div className="secret-toggles">
          <label>
            <input type="checkbox" checked={values.global} onChange={(e) => set('global', e.target.checked)} />
            Available to all projects
          </label>
          <label>
            <input type="checkbox" checked={values.exposeToAgents} onChange={(e) => set('exposeToAgents', e.target.checked)} />
            Available to agents
          </label>
          <label>
            <input type="checkbox" checked={values.useForGit} onChange={(e) => set('useForGit', e.target.checked)} />
            Use for git &amp; GitHub CLI
          </label>
        </div>
      )}
      <div className="modal-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!values.value || (mode === 'create' && !values.name)} onClick={() => onSubmit(values)}>
          {mode === 'create' ? 'Store' : 'Replace'}
        </button>
      </div>
    </div>
  )
}
