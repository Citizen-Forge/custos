import { useEffect, useState } from 'react'
import SetupScreen from './components/SetupScreen'
import Shell from './components/Shell'

type Phase = 'loading' | 'setup' | 'shell'

export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')

  useEffect(() => {
    window.custos.getConfig().then((status) => {
      setPhase(status.baseUrl && status.loggedIn ? 'shell' : 'setup')
    })
  }, [])

  if (phase === 'loading') return <div className="empty-state">Loading…</div>
  if (phase === 'setup') return <SetupScreen onConnected={() => setPhase('shell')} />
  return <Shell onSessionExpired={() => setPhase('setup')} />
}
