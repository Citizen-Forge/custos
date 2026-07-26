import { useState } from 'react'

export interface NewProjectValues {
  name: string
  repoUrl: string
  description: string
}

/**
 * Creating a project used to ask only for a name, which served a brand-new
 * project fine and an existing codebase badly: you got an empty folder, and
 * every agent's first ticket was also its first attempt at working out what
 * the project was and how to build it.
 *
 * Asking for the repository and a description up front means the code is
 * there before anyone is asked to work on it, and the survey pass can write
 * down the build and test commands once instead of each agent rediscovering
 * them.
 */
export default function NewProjectModal({
  onSubmit,
  onCancel
}: {
  onSubmit: (values: NewProjectValues) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<NewProjectValues>({ name: '', repoUrl: '', description: '' })
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof NewProjectValues,>(key: K, v: NewProjectValues[K]): void =>
    setValues((prev) => ({ ...prev, [key]: v }))

  async function submit(): Promise<void> {
    if (!values.name.trim() || busy) return
    setBusy(true)
    await onSubmit({ ...values, name: values.name.trim(), repoUrl: values.repoUrl.trim(), description: values.description.trim() })
    setBusy(false)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            value={values.name}
            placeholder="my-app"
            onChange={(e) => set('name', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        <label className="field">
          <span>Existing repository (optional)</span>
          <input
            type="text"
            value={values.repoUrl}
            placeholder="https://github.com/you/my-app.git"
            onChange={(e) => set('repoUrl', e.target.value)}
          />
          <small>
            Cloned into the project workspace using the git credentials in your vault. Leave blank to start empty — DevOps can
            create a repository for you later.
          </small>
        </label>

        <label className="field">
          <span>What is this project? (optional)</span>
          <textarea
            rows={3}
            value={values.description}
            placeholder="A 10-foot TV interface for local media, Electron + React, talks to Sonarr/Radarr."
            onChange={(e) => set('description', e.target.value)}
          />
          <small>Recorded in the shared knowledge store, so every agent reads it before touching anything.</small>
        </label>

        {values.repoUrl.trim() && (
          <p className="hint">
            After cloning, the product owner will survey the codebase once and write down the build and test commands, stack and
            conventions — so the first real ticket isn&rsquo;t also the first attempt at working those out.
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={!values.name.trim() || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
