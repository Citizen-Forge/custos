import { useEffect, useRef, useState } from 'react'

interface WebviewElement extends HTMLElement {
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
}

/**
 * Embeds Custos's own web admin panel directly rather than reimplementing
 * provider config, routing priorities, and the security panel natively --
 * it's a real, isolated browser context (its own partition/cookie jar), so
 * it has its own independent /login. To avoid asking the user to type the
 * admin password twice, the first time this loads the login page we
 * autofill and submit it using the password captured during the app's own
 * setup screen (kept in the main process only, never written to disk).
 */
export default function SettingsView(): React.JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    window.custos.getEmbedUrl().then(setUrl)
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !url) return

    const handleLoad = async (): Promise<void> => {
      if (!webview.getURL().includes('/login')) return
      const password = await window.custos.getAutofillPassword()
      if (!password) return
      await webview.executeJavaScript(`
        (function() {
          const input = document.getElementById('password');
          if (!input) return;
          input.value = ${JSON.stringify(password)};
          const button = document.querySelector('#form button[type=submit]');
          if (button) button.click();
        })();
      `)
    }

    webview.addEventListener('did-finish-load', handleLoad)
    return () => webview.removeEventListener('did-finish-load', handleLoad)
  }, [url])

  if (!url) return <div className="empty-state">Loading…</div>

  return <webview ref={webviewRef} src={url} partition="persist:custos-admin" />
}
