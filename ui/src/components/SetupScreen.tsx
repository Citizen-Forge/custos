import { FormEvent, useEffect, useState } from 'react'

export default function SetupScreen({ onConnected }: { onConnected: () => void }): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.custos.getConfig().then((status) => {
      if (status.baseUrl) setBaseUrl(status.baseUrl)
    })
  }, [])

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!baseUrl.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      await window.custos.setBaseUrl(baseUrl.trim())
      const result = await window.custos.login(password)
      if (!result.ok) {
        setError(result.error || 'Login failed')
        return
      }
      onConnected()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-screen">
      <form className="setup-card" onSubmit={handleSubmit}>
        <h1>Connect to Custos</h1>
        <p>Enter your Custos instance's address and admin password -- the same one used for the web admin panel.</p>
        <input
          type="text"
          placeholder="https://your-custos-host"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <span className="error-text">{error}</span>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
