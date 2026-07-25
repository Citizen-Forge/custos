import { useEffect, useState } from 'react'

/**
 * Embeds Custos's own admin panel rather than reimplementing provider
 * config, routing priorities and the security panel natively.
 *
 * A plain iframe, not Electron's <webview>: that tag doesn't exist in a
 * browser, so it rendered an empty pane in the web build. It also isn't
 * needed any more — the app is served from the same origin as /admin in
 * both the browser and the desktop client (which hands its window over to
 * the hosted UI after setup), so the iframe shares the session cookie and
 * is simply already logged in. The old build had to run in an isolated
 * partition with its own login, which is why it used to autofill the
 * password on the embedded page's behalf.
 */
export default function SettingsView(): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    window.custos.getEmbedUrl().then(setUrl)
  }, [])

  if (!url) return <div className="empty-state">Loading…</div>

  return <iframe className="settings-frame" src={url} title="Custos admin" />
}
