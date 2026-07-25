import { FormEvent, useEffect, useRef, useState } from 'react'

export interface PromptRequest {
  title: string
  defaultValue?: string
  placeholder?: string
  submitLabel?: string
}

/**
 * Electron's renderer implements window.alert()/confirm() natively but not
 * window.prompt() -- it silently no-ops instead of showing a dialog. This
 * is the in-app replacement for every text-entry prompt in the app.
 */
export default function PromptModal({
  request,
  onSubmit,
  onCancel
}: {
  request: PromptRequest
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(request.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    onSubmit(value)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>{request.title}</h2>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {request.submitLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
